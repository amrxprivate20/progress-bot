// src/utils/locks.ts
import { SupabaseClient, op } from '../database/client';

/**
 * Acquire a lock for a specific operation
 * Returns true if lock acquired, false if already locked
 */
export async function acquireLock(
  db: SupabaseClient,
  lockKey: string,
  timeoutMs: number = 30000 // 30 seconds default
): Promise<boolean> {
  try {
    // Check if lock exists and is still valid
    const existing = await db.select('conversation_state', {
      filter: { chat_id: op.eq(lockKey) },
    });

    if (existing.length > 0) {
      const lock = existing[0];
      const expiresAt = new Date(lock.expires_at);
      
      if (expiresAt > new Date()) {
        // Lock still valid
        return false;
      }
      
      // Lock expired, delete it
      await db.delete('conversation_state', { chat_id: op.eq(lockKey) });
    }

    // Create new lock
    await db.insert('conversation_state', {
      chat_id: lockKey,
      conversation_type: 'operation_lock',
      current_step: 0,
      total_steps: 0,
      data: { createdAt: Date.now() },
      expires_at: new Date(Date.now() + timeoutMs).toISOString(),
    });

    return true;
  } catch (error) {
    console.error('Error acquiring lock:', error);
    return false;
  }
}

/**
 * Release a lock
 */
export async function releaseLock(
  db: SupabaseClient,
  lockKey: string
): Promise<void> {
  try {
    await db.delete('conversation_state', { chat_id: op.eq(lockKey) });
  } catch (error) {
    console.error('Error releasing lock:', error);
  }
}

/**
 * Execute a function with a lock
 */
export async function withLock<T>(
  db: SupabaseClient,
  lockKey: string,
  operation: () => Promise<T>,
  maxRetries: number = 5,
  retryDelayMs: number = 1000
): Promise<T | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquired = await acquireLock(db, lockKey);
    
    if (acquired) {
      try {
        const result = await operation();
        return result;
      } finally {
        await releaseLock(db, lockKey);
      }
    }
    
    // Lock not acquired, wait and retry
    console.log(`Lock ${lockKey} busy, retry ${attempt + 1}/${maxRetries}`);
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }
  
  console.error(`Failed to acquire lock ${lockKey} after ${maxRetries} attempts`);
  return null;
}
