/**
 * Supabase Storage Service
 *
 * Handles:
 * - Uploading media files (images, videos, voice messages)
 * - Generating public URLs
 * - Downloading files from Telegram and storing in Supabase
 */


// ============================================
// Types
// ============================================

export interface StorageUploadResult {
  success: boolean;
  url?: string;
  path?: string;
  error?: string;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ============================================
// Supabase Storage Client
// ============================================

export class SupabaseStorageClient {
  private supabaseUrl: string;
  private supabaseKey: string;
  private bucketName: string;

  constructor(supabaseUrl: string, supabaseKey: string, bucketName: string = 'journal-media') {
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.bucketName = bucketName;
  }

  /**
   * Upload a file to Supabase Storage
   */
  async uploadFile(
    filePath: string,
    fileData: ArrayBuffer,
    contentType: string
  ): Promise<StorageUploadResult> {
    try {
      const url = `${this.supabaseUrl}/storage/v1/object/${this.bucketName}/${filePath}`;
      console.log('📤 Uploading to Supabase Storage:', {
        bucket: this.bucketName,
        path: filePath,
        contentType,
        size: fileData.byteLength,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.supabaseKey}`,
          'Content-Type': contentType,
          'x-upsert': 'true', // Overwrite if exists
        },
        body: fileData,
      });

      const responseText = await response.text();
      console.log('📤 Supabase response:', response.status, responseText.substring(0, 200));

      if (!response.ok) {
        console.error('Supabase Storage upload failed:', responseText);
        // Parse common errors for better messages
        let errorMessage = `Upload failed: ${response.status}`;
        if (response.status === 404) {
          errorMessage = 'Bucket not found - create bucket "journal-media" in Supabase';
        } else if (response.status === 400) {
          // Check for JWT-related errors
          if (responseText.includes('Invalid Compact JWS') || responseText.includes('JWT')) {
            errorMessage = 'Invalid JWT token - use SUPABASE_SERVICE_ROLE_KEY for storage uploads';
          } else {
            errorMessage = 'Bad request - check bucket configuration';
          }
        } else if (response.status === 403) {
          if (responseText.includes('Invalid Compact JWS') || responseText.includes('JWT')) {
            errorMessage = 'Invalid JWT - configure SUPABASE_SERVICE_ROLE_KEY env variable';
          } else {
            errorMessage = 'Access denied - check bucket policies or use service role key';
          }
        }
        console.error('Storage upload failed:', errorMessage);
        return {
          success: false,
          error: errorMessage,
        };
      }

      // Generate public URL
      const publicUrl = `${this.supabaseUrl}/storage/v1/object/public/${this.bucketName}/${filePath}`;

      return {
        success: true,
        url: publicUrl,
        path: filePath,
      };
    } catch (error) {
      console.error('Error uploading to Supabase Storage:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Delete a file from Supabase Storage
   */
  async deleteFile(filePath: string): Promise<boolean> {
    try {
      const url = `${this.supabaseUrl}/storage/v1/object/${this.bucketName}/${filePath}`;

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.supabaseKey}`,
        },
      });

      return response.ok;
    } catch (error) {
      console.error('Error deleting from Supabase Storage:', error);
      return false;
    }
  }

  /**
   * Get public URL for a file
   */
  getPublicUrl(filePath: string): string {
    return `${this.supabaseUrl}/storage/v1/object/public/${this.bucketName}/${filePath}`;
  }
}

// ============================================
// Telegram Media Downloader
// ============================================

export class TelegramMediaDownloader {
  private botToken: string;
  private apiBase: string;

  constructor(botToken: string) {
    this.botToken = botToken;
    this.apiBase = `https://api.telegram.org/bot${botToken}`;
  }

  /**
   * Get file info from Telegram
   */
  async getFile(fileId: string): Promise<TelegramFile | null> {
    try {
      const response = await fetch(`${this.apiBase}/getFile?file_id=${fileId}`);
      const data = await response.json() as { ok: boolean; result?: TelegramFile };

      if (data.ok && data.result) {
        return data.result;
      }

      return null;
    } catch (error) {
      console.error('Error getting file info from Telegram:', error);
      return null;
    }
  }

  /**
   * Download file from Telegram
   */
  async downloadFile(filePath: string): Promise<ArrayBuffer | null> {
    try {
      const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      const response = await fetch(url);

      if (!response.ok) {
        console.error('Failed to download from Telegram:', response.status);
        return null;
      }

      return await response.arrayBuffer();
    } catch (error) {
      console.error('Error downloading file from Telegram:', error);
      return null;
    }
  }

  /**
   * Download file by file_id
   */
  async downloadFileById(fileId: string): Promise<{ data: ArrayBuffer; filePath: string } | null> {
    const fileInfo = await this.getFile(fileId);

    if (!fileInfo || !fileInfo.file_path) {
      return null;
    }

    const data = await this.downloadFile(fileInfo.file_path);

    if (!data) {
      return null;
    }

    return { data, filePath: fileInfo.file_path };
  }
}

// ============================================
// Media Storage Service (combines both)
// ============================================

export class MediaStorageService {
  private storage: SupabaseStorageClient;
  private telegram: TelegramMediaDownloader;

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    botToken: string,
    bucketName: string = 'journal-media'
  ) {
    this.storage = new SupabaseStorageClient(supabaseUrl, supabaseKey, bucketName);
    this.telegram = new TelegramMediaDownloader(botToken);
  }

  /**
   * Download media from Telegram and upload to Supabase Storage
   */
  async transferFromTelegram(
    fileId: string,
    mediaType: 'image' | 'video' | 'voice' | 'document',
    date: string
  ): Promise<StorageUploadResult> {
    try {
      // Download from Telegram
      const downloaded = await this.telegram.downloadFileById(fileId);

      if (!downloaded) {
        return {
          success: false,
          error: 'Failed to download from Telegram',
        };
      }

      // Determine file extension and content type
      const { extension, contentType } = this.getFileTypeInfo(downloaded.filePath, mediaType);

      // Generate storage path: journal/2026-01-16/image_123456.jpg
      const timestamp = Date.now();
      const storagePath = `journal/${date}/${mediaType}_${timestamp}${extension}`;

      // Upload to Supabase
      return await this.storage.uploadFile(storagePath, downloaded.data, contentType);
    } catch (error) {
      console.error('Error transferring media:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get file extension and content type based on Telegram file path
   */
  private getFileTypeInfo(
    filePath: string,
    mediaType: 'image' | 'video' | 'voice' | 'document'
  ): { extension: string; contentType: string } {
    // Extract extension from Telegram file path
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    const typeMap: Record<string, { extension: string; contentType: string }> = {
      // Images
      'jpg': { extension: '.jpg', contentType: 'image/jpeg' },
      'jpeg': { extension: '.jpg', contentType: 'image/jpeg' },
      'png': { extension: '.png', contentType: 'image/png' },
      'gif': { extension: '.gif', contentType: 'image/gif' },
      'webp': { extension: '.webp', contentType: 'image/webp' },
      // Videos
      'mp4': { extension: '.mp4', contentType: 'video/mp4' },
      'mov': { extension: '.mov', contentType: 'video/quicktime' },
      'avi': { extension: '.avi', contentType: 'video/x-msvideo' },
      // Voice/Audio
      'ogg': { extension: '.ogg', contentType: 'audio/ogg' },
      'oga': { extension: '.oga', contentType: 'audio/ogg' },
      'mp3': { extension: '.mp3', contentType: 'audio/mpeg' },
      'm4a': { extension: '.m4a', contentType: 'audio/mp4' },
      // Documents
      'pdf': { extension: '.pdf', contentType: 'application/pdf' },
      'doc': { extension: '.doc', contentType: 'application/msword' },
      'docx': { extension: '.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    };

    if (typeMap[ext]) {
      return typeMap[ext];
    }

    // Fallback based on media type
    const fallbacks: Record<string, { extension: string; contentType: string }> = {
      'image': { extension: '.jpg', contentType: 'image/jpeg' },
      'video': { extension: '.mp4', contentType: 'video/mp4' },
      'voice': { extension: '.ogg', contentType: 'audio/ogg' },
      'document': { extension: '.bin', contentType: 'application/octet-stream' },
    };

    return fallbacks[mediaType] || { extension: '.bin', contentType: 'application/octet-stream' };
  }

  /**
   * Get public URL for stored media
   */
  getPublicUrl(storagePath: string): string {
    return this.storage.getPublicUrl(storagePath);
  }
}

// ============================================
// Factory Function
// ============================================

export function createMediaStorageService(
  supabaseUrl: string,
  supabaseKey: string,
  botToken: string
): MediaStorageService {
  return new MediaStorageService(supabaseUrl, supabaseKey, botToken);
}
