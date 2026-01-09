// ============================================
// Supabase Database Client - FIXED VERSION
// ============================================
// Simple REST API client for Supabase without SDK dependency
// FIXED: Properly consume response bodies to prevent deadlock warnings

import type { Env } from '../types';

/**
 * Supabase client for Cloudflare Workers
 * Uses REST API instead of the official SDK for better edge compatibility
 */
export class SupabaseClient {
  private url: string;
  private apiKey: string;

  constructor(env: Env) {
    this.url = env.SUPABASE_URL;
    this.apiKey = env.SUPABASE_ANON_KEY;

    // Validate environment variables
    if (!this.url || !this.apiKey) {
      throw new Error('Missing Supabase credentials in environment');
    }
  }

  /**
   * Get common headers for Supabase requests
   */
  private getHeaders(): HeadersInit {
    return {
      'apikey': this.apiKey,
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation', // Return inserted/updated data
    };
  }

  /**
   * Execute a query with automatic retry logic
   * FIXED: Properly handle response bodies
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    maxAttempts: number = 3
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on 4xx errors (client errors)
        if (error instanceof Response && error.status >= 400 && error.status < 500) {
          throw error;
        }

        // Wait before retrying (exponential backoff)
        if (attempt < maxAttempts) {
          const delayMs = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    throw lastError || new Error('Query failed after retries');
  }

  /**
   * SELECT query
   * FIXED: Ensure response body is always consumed
   */
  async select<T = any>(
    table: string,
    query: {
      columns?: string;
      filter?: Record<string, any>;
      order?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<T[]> {
    return this.executeWithRetry(async () => {
      const params = new URLSearchParams();
      
      if (query.columns) {
        params.append('select', query.columns);
      }

      if (query.filter) {
        for (const [key, value] of Object.entries(query.filter)) {
          params.append(key, value);
        }
      }

      if (query.order) {
        params.append('order', query.order);
      }

      if (query.limit) {
        params.append('limit', query.limit.toString());
      }

      if (query.offset) {
        params.append('offset', query.offset.toString());
      }

      const url = `${this.url}/rest/v1/${table}?${params.toString()}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      // ALWAYS consume the response body
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Supabase SELECT failed: ${response.status} ${responseText}`);
      }

      // Parse the consumed text
      return JSON.parse(responseText);
    });
  }

  /**
   * INSERT query
   * FIXED: Ensure response body is consumed
   */
  async insert<T = any>(
    table: string,
    data: Record<string, any> | Record<string, any>[]
  ): Promise<T[]> {
    return this.executeWithRetry(async () => {
      const url = `${this.url}/rest/v1/${table}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(data),
      });

      // ALWAYS consume the response body
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Supabase INSERT failed: ${response.status} ${responseText}`);
      }

      return JSON.parse(responseText);
    });
  }

  /**
   * UPDATE query
   * FIXED: Ensure response body is consumed
   */
  async update<T = any>(
    table: string,
    filter: Record<string, any>,
    data: Record<string, any>
  ): Promise<T[]> {
    return this.executeWithRetry(async () => {
      const params = new URLSearchParams();
      
      for (const [key, value] of Object.entries(filter)) {
        params.append(key, value);
      }

      const url = `${this.url}/rest/v1/${table}?${params.toString()}`;
      
      const response = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify(data),
      });

      // ALWAYS consume the response body
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Supabase UPDATE failed: ${response.status} ${responseText}`);
      }

      return JSON.parse(responseText);
    });
  }

  /**
   * UPSERT query (insert or update)
   * FIXED: Ensure response body is consumed
   */
  async upsert<T = any>(
    table: string,
    data: Record<string, any> | Record<string, any>[],
    onConflict?: string
  ): Promise<T[]> {
    return this.executeWithRetry(async () => {
      const params = new URLSearchParams();
      if (onConflict) {
        params.append('on_conflict', onConflict);
      }

      const url = `${this.url}/rest/v1/${table}?${params.toString()}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Prefer': 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(data),
      });

      // ALWAYS consume the response body
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Supabase UPSERT failed: ${response.status} ${responseText}`);
      }

      return JSON.parse(responseText);
    });
  }

  /**
   * DELETE query
   * FIXED: Ensure response body is consumed
   */
  async delete<T = any>(
    table: string,
    filter: Record<string, any>
  ): Promise<T[]> {
    return this.executeWithRetry(async () => {
      const params = new URLSearchParams();
      
      for (const [key, value] of Object.entries(filter)) {
        params.append(key, value);
      }

      const url = `${this.url}/rest/v1/${table}?${params.toString()}`;
      
      const response = await fetch(url, {
        method: 'DELETE',
        headers: this.getHeaders(),
      });

      // ALWAYS consume the response body (even for DELETE)
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Supabase DELETE failed: ${response.status} ${responseText}`);
      }

      // Return empty array or parsed response
      return responseText ? JSON.parse(responseText) : [];
    });
  }

  /**
   * Execute RPC (stored procedure)
   * FIXED: Ensure response body is consumed
   */
  async rpc<T = any>(
    functionName: string,
    params: Record<string, any> = {}
  ): Promise<T> {
    return this.executeWithRetry(async () => {
      const url = `${this.url}/rest/v1/rpc/${functionName}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(params),
      });

      // ALWAYS consume the response body
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(`Supabase RPC failed: ${response.status} ${responseText}`);
      }

      return JSON.parse(responseText);
    });
  }

  /**
   * Health check - verify connection to Supabase
   * FIXED: Properly consume response
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.select('settings', { limit: 1 });
      return true;
    } catch (error) {
      console.error('Supabase health check failed:', error);
      return false;
    }
  }
}

/**
 * Helper function to create Supabase client
 */
export function createSupabaseClient(env: Env): SupabaseClient {
  return new SupabaseClient(env);
}

/**
 * Helper to format Supabase filter operators
 * Examples:
 *   eq('done') -> 'eq.done'
 *   gte(100) -> 'gte.100'
 *   like('%test%') -> 'like.*test*'
 */
export const operators = {
  eq: (value: any) => `eq.${value}`,
  neq: (value: any) => `neq.${value}`,
  gt: (value: any) => `gt.${value}`,
  gte: (value: any) => `gte.${value}`,
  lt: (value: any) => `lt.${value}`,
  lte: (value: any) => `lte.${value}`,
  like: (value: string) => `like.${value}`,
  ilike: (value: string) => `ilike.${value}`,
  is: (value: 'null' | 'true' | 'false') => `is.${value}`,
  in: (values: any[]) => `in.(${values.join(',')})`,
  not: {
    in: (values: any[]) => `not.in.(${values.join(',')})`,
  },
};

// Export shorthand
export const op = operators;