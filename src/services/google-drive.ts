/**
 * Google Drive Integration Service
 *
 * Handles:
 * - Uploading daily reports as markdown files
 * - Managing folder structure (main folder + Gallery subfolder)
 * - Creating _LastUpdate.md status file
 * - Uses Service Account authentication
 *
 * Note: Requires Google Service Account JSON credentials
 */

import { SupabaseClient } from '../database/client';
import { SettingsManager } from '../database/settings';
import { DailyReport } from '../types';
import { getTodayInEgypt, formatArabicDate } from '../utils/timezone';
import { retryWithBackoff, ExternalAPIError } from '../utils/errors';

// ============================================
// Types
// ============================================

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
}

export interface DriveUploadResult {
  success: boolean;
  fileId?: string;
  webViewLink?: string;
  error?: string;
}

export interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

// ============================================
// Google Drive Client
// ============================================

export class GoogleDriveClient {
  private accessToken: string | null = null;
  private tokenExpiry: Date | null = null;
  private baseUrl = 'https://www.googleapis.com/drive/v3';
  private uploadUrl = 'https://www.googleapis.com/upload/drive/v3';

  constructor(
    private credentials: ServiceAccountCredentials,
    private folderId: string
  ) {}

  /**
   * Upload a markdown file to Google Drive
   */
  async uploadMarkdownFile(
    fileName: string,
    content: string,
    folderId?: string
  ): Promise<DriveUploadResult> {
    try {
      await this.ensureAccessToken();

      const targetFolderId = folderId || this.folderId;

      // Check if file already exists
      const existingFile = await this.findFile(fileName, targetFolderId);

      if (existingFile) {
        // Update existing file
        return await this.updateFile(existingFile.id, content);
      } else {
        // Create new file
        return await this.createFile(fileName, content, targetFolderId);
      }
    } catch (error) {
      console.error('Error uploading file to Drive:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Create a new file in Google Drive
   */
  private async createFile(
    fileName: string,
    content: string,
    parentFolderId: string
  ): Promise<DriveUploadResult> {
    return retryWithBackoff(async () => {
      // Create file metadata
      const metadata = {
        name: fileName,
        mimeType: 'text/markdown',
        parents: [parentFolderId],
      };

      // Create multipart request
      const boundary = '-------314159265358979323846';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBody =
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: text/markdown; charset=UTF-8\r\n\r\n' +
        content +
        closeDelimiter;

      // supportsAllDrives=true allows uploading to Shared Drives
      const response = await fetch(
        `${this.uploadUrl}/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        throw new ExternalAPIError(
          `Google Drive API error: ${response.status} ${responseText}`,
          'google_drive'
        );
      }

      const file = JSON.parse(responseText);

      return {
        success: true,
        fileId: file.id,
        webViewLink: file.webViewLink,
      };
    }, { maxAttempts: 3, initialDelayMs: 500 });
  }

  /**
   * Update an existing file in Google Drive
   */
  private async updateFile(
    fileId: string,
    content: string
  ): Promise<DriveUploadResult> {
    return retryWithBackoff(async () => {
      const response = await fetch(
        `${this.uploadUrl}/files/${fileId}?uploadType=media&fields=id,name,webViewLink&supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'text/markdown; charset=UTF-8',
          },
          body: content,
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        throw new ExternalAPIError(
          `Google Drive API error: ${response.status} ${responseText}`,
          'google_drive'
        );
      }

      const file = JSON.parse(responseText);

      return {
        success: true,
        fileId: file.id,
        webViewLink: file.webViewLink,
      };
    }, { maxAttempts: 3, initialDelayMs: 500 });
  }

  /**
   * Find a file by name in a specific folder
   */
  private async findFile(
    fileName: string,
    folderId: string
  ): Promise<DriveFile | null> {
    await this.ensureAccessToken();

    const query = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
    const encodedQuery = encodeURIComponent(query);

    // includeItemsFromAllDrives and supportsAllDrives for Shared Drives support
    const response = await fetch(
      `${this.baseUrl}/files?q=${encodedQuery}&fields=files(id,name,mimeType,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new ExternalAPIError(
        `Google Drive API error: ${response.status} ${responseText}`,
        'google_drive'
      );
    }

    const result = JSON.parse(responseText);

    if (result.files && result.files.length > 0) {
      return result.files[0];
    }

    return null;
  }

  /**
   * Create or get the Gallery subfolder
   */
  async getOrCreateGalleryFolder(): Promise<string | null> {
    try {
      await this.ensureAccessToken();

      // Check if Gallery folder exists
      const existingFolder = await this.findFile('Gallery', this.folderId);

      if (existingFolder) {
        return existingFolder.id;
      }

      // Create Gallery folder
      const metadata = {
        name: 'Gallery',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [this.folderId],
      };

      const response = await fetch(
        `${this.baseUrl}/files?fields=id&supportsAllDrives=true`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(metadata),
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        throw new ExternalAPIError(
          `Google Drive API error: ${response.status} ${responseText}`,
          'google_drive'
        );
      }

      const folder = JSON.parse(responseText);
      return folder.id;
    } catch (error) {
      console.error('Error creating Gallery folder:', error);
      return null;
    }
  }

  /**
   * Ensure we have a valid access token
   */
  private async ensureAccessToken(): Promise<void> {
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return;
    }

    const token = await this.getAccessToken();
    this.accessToken = token.access_token;
    this.tokenExpiry = new Date(Date.now() + (token.expires_in - 60) * 1000);
  }

  /**
   * Get access token using service account credentials
   */
  private async getAccessToken(): Promise<{ access_token: string; expires_in: number }> {
    // Create JWT for service account auth
    const jwt = await this.createServiceAccountJWT();

    const response = await fetch(this.credentials.token_uri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    const responseText = await response.text();

    if (!response.ok) {
      throw new ExternalAPIError(
        `Google OAuth error: ${response.status} ${responseText}`,
        'google_oauth'
      );
    }

    return JSON.parse(responseText);
  }

  /**
   * Create JWT for service account authentication
   */
  private async createServiceAccountJWT(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const expiry = now + 3600; // 1 hour

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const payload = {
      iss: this.credentials.client_email,
      scope: 'https://www.googleapis.com/auth/drive.file',
      aud: this.credentials.token_uri,
      iat: now,
      exp: expiry,
    };

    const headerB64 = this.base64UrlEncode(JSON.stringify(header));
    const payloadB64 = this.base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${headerB64}.${payloadB64}`;

    // Sign with private key
    const signature = await this.signWithPrivateKey(unsignedToken, this.credentials.private_key);

    return `${unsignedToken}.${signature}`;
  }

  /**
   * Base64URL encode
   */
  private base64UrlEncode(str: string): string {
    const base64 = btoa(str);
    return base64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /**
   * Sign data with RSA private key
   */
  private async signWithPrivateKey(data: string, privateKey: string): Promise<string> {
    // Parse PEM private key
    const pemHeader = '-----BEGIN PRIVATE KEY-----';
    const pemFooter = '-----END PRIVATE KEY-----';
    const pemContents = privateKey
      .replace(pemHeader, '')
      .replace(pemFooter, '')
      .replace(/\\n/g, '')
      .replace(/\s/g, '');

    const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

    // Import key
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );

    // Sign
    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      encoder.encode(data)
    );

    // Convert to base64url
    const signatureArray = new Uint8Array(signature);
    const signatureBase64 = btoa(String.fromCharCode(...signatureArray));

    return signatureBase64
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
}

// ============================================
// Drive Service (High-level API)
// ============================================

export class DriveService {
  constructor(
    private db: SupabaseClient,
    private settings: SettingsManager
  ) {}

  /**
   * Save a daily report to Google Drive
   */
  async saveReport(report: DailyReport): Promise<DriveUploadResult> {
    const client = await this.createClient();

    if (!client) {
      return {
        success: false,
        error: 'Google Drive not configured',
      };
    }

    // Format filename
    const reportDate = typeof report.report_date === 'string'
      ? report.report_date
      : new Date(report.report_date).toISOString().split('T')[0];

    const fileName = `${reportDate}.md`;

    // Upload report
    return await client.uploadMarkdownFile(fileName, report.report_markdown);
  }

  /**
   * Update _LastUpdate.md status file
   */
  async updateLastUpdateFile(): Promise<DriveUploadResult> {
    const client = await this.createClient();

    if (!client) {
      return {
        success: false,
        error: 'Google Drive not configured',
      };
    }

    const today = getTodayInEgypt();
    const now = new Date();
    const timeStr = now.toLocaleTimeString('ar-EG', { timeZone: 'Africa/Cairo' });

    // Get latest stats
    const reports = await this.db.select('daily_reports', {
      order: 'report_date.desc',
      limit: 1,
    });

    const streaks = await this.db.select('streaks', {});
    const activeStreaks = streaks.filter((s: any) => s.current_streak > 0);

    let content = `# آخر تحديث\n\n`;
    content += `📅 التاريخ: ${formatArabicDate(new Date(today))}\n`;
    content += `🕐 الوقت: ${timeStr}\n\n`;

    if (reports.length > 0) {
      const lastReport = reports[0];
      content += `## آخر تقرير\n`;
      content += `- التاريخ: ${lastReport.report_date}\n`;
      content += `- معدل النجاح: ${lastReport.success_rate}%\n`;
      content += `- المهام المكتملة: ${lastReport.completed_tasks}\n\n`;
    }

    content += `## السلاسل النشطة (${activeStreaks.length})\n`;
    for (const streak of activeStreaks.slice(0, 10)) {
      content += `- ${streak.task_name}: ${streak.current_streak} يوم\n`;
    }

    content += `\n---\n`;
    content += `_تم التحديث تلقائياً بواسطة Progress Bot_\n`;

    return await client.uploadMarkdownFile('_LastUpdate.md', content);
  }

  /**
   * Create Drive client from settings
   */
  private async createClient(): Promise<GoogleDriveClient | null> {
    try {
      const folderId = await this.settings.get('google_drive_folder_id');
      const credentialsJson = await this.settings.get('google_service_account');

      if (!folderId || folderId === 'YOUR_FOLDER_ID_HERE') {
        console.log('Google Drive folder ID not configured');
        return null;
      }

      if (!credentialsJson) {
        console.log('Google Service Account credentials not configured');
        return null;
      }

      const credentials = JSON.parse(credentialsJson) as ServiceAccountCredentials;

      return new GoogleDriveClient(credentials, folderId);
    } catch (error) {
      console.error('Error creating Drive client:', error);
      return null;
    }
  }
}

// ============================================
// Factory Function
// ============================================

export function createDriveService(
  db: SupabaseClient,
  settings: SettingsManager
): DriveService {
  return new DriveService(db, settings);
}
