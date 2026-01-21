// src/utils/command-lock.ts
import { SupabaseClient, op } from '../database/client';

const COMMAND_LOCK_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Acquire a command lock for a user
 * Returns true if lock acquired, false if already locked
 */
export async function acquireCommandLock(
  db: SupabaseClient,
  chatId: string,
  commandName: string
): Promise<boolean> {
  const lockKey = `command_lock_${chatId}`;
  
  try {
    // Check if there's an existing lock
    const existingLock = await db.select('conversation_state', {
      filter: { chat_id: op.eq(lockKey) },
    });

    if (existingLock.length > 0) {
      const lock = existingLock[0] as any;
      const expiresAt = new Date(lock.expires_at);
      
      // Check if lock is still valid
      if (expiresAt > new Date()) {
        const lockedCommand = lock.data?.commandName || 'unknown';
        console.log(`⚠️ Chat ${chatId} is locked by command: ${lockedCommand}`);
        return false;
      }
      
      // Lock expired, clean it up
      await db.delete('conversation_state', { chat_id: op.eq(lockKey) });
    }

    // Acquire new lock
    await db.insert('conversation_state', {
      chat_id: lockKey,
      conversation_type: 'command_lock',
      current_step: 0,
      total_steps: 0,
      data: { 
        commandName,
        startedAt: Date.now() 
      },
      expires_at: new Date(Date.now() + COMMAND_LOCK_TIMEOUT).toISOString(),
    });

    console.log(`✅ Command lock acquired for ${chatId}: ${commandName}`);
    return true;
    
  } catch (error) {
    console.error('❌ Error acquiring command lock:', error);
    return false;
  }
}

/**
 * Release a command lock
 */
export async function releaseCommandLock(
  db: SupabaseClient,
  chatId: string
): Promise<void> {
  const lockKey = `command_lock_${chatId}`;
  
  try {
    await db.delete('conversation_state', { chat_id: op.eq(lockKey) });
    console.log(`✅ Command lock released for ${chatId}`);
  } catch (error) {
    console.error('❌ Error releasing command lock:', error);
  }
}

/**
 * Get the currently locked command name
 */
export async function getLockedCommand(
  db: SupabaseClient,
  chatId: string
): Promise<string | null> {
  const lockKey = `command_lock_${chatId}`;
  
  try {
    const existingLock = await db.select('conversation_state', {
      filter: { chat_id: op.eq(lockKey) },
    });

    if (existingLock.length > 0) {
      const lock = existingLock[0] as any;
      const expiresAt = new Date(lock.expires_at);
      
      if (expiresAt > new Date()) {
        return lock.data?.commandName || 'unknown command';
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error getting locked command:', error);
    return null;
  }
}
