// ==============================================================================
// Report Processing Handler - Runs independently of webhook
// FIXED: Proper database filter syntax
// ==============================================================================

import type { SupabaseClient } from '../database/client';
import type { SettingsManager } from '../database/settings';
import { op } from '../database/client';
import { createReportGenerator } from '../services/report-generator';
import { createAIClient } from '../services/ai-client';
import { createMemoryManager } from '../services/memory-manager';

/**
 * Process full report (called via separate endpoint)
 * This runs in a fresh worker context, not tied to the webhook timeout
 */
export async function handleReportProcessing(
  request: Request,
  db: SupabaseClient,
  settings: SettingsManager
): Promise<Response> {
  console.log('🚀 handleReportProcessing called');
  
  try {
    // Verify this is an internal call
    const internalHeader = request.headers.get('X-Internal-Call');
    console.log('🔐 Internal header:', internalHeader);
    
    if (!internalHeader) {
      console.log('❌ Unauthorized - missing internal header');
      return new Response('Unauthorized', { status: 401 });
    }

    const body = await request.json() as { chat_id: string; api_key: string };
    const { chat_id, api_key } = body;
    
    console.log('📊 Processing for chat:', chat_id);

    if (!chat_id || !api_key) {
      console.log('❌ Missing parameters');
      return new Response('Missing parameters', { status: 400 });
    }

    // Get bot token for sending messages
    const botToken = await settings.get('telegram_bot_token');
    if (!botToken) {
      console.log('❌ Bot token not configured');
      return new Response('Bot token not configured', { status: 500 });
    }

    const storageKey = `processing_${chat_id}`;
    console.log('🔍 Looking for stored data with key:', storageKey);

    // Retrieve stored report data - FIXED: Use op.eq() for filter
    const storedData = await db.select('conversation_state', {
      filter: { 
        chat_id: op.eq(storageKey)
      },
      limit: 1,
    });

    console.log('📦 Stored data found:', storedData.length > 0);

    if (storedData.length === 0) {
      console.log('❌ No stored data found');
      await sendTelegramMessage(
        chat_id,
        botToken,
        '❌ لم يتم العثور على بيانات التقرير. الرجاء المحاولة مرة أخرى.'
      );
      return new Response('Report data not found', { status: 404 });
    }

    const { reportData, userAnswers } = storedData[0]?.data || {};
    
    console.log('📋 Report data exists:', !!reportData);
    console.log('💬 User answers:', Object.keys(userAnswers || {}).length);
    
    if (!reportData) {
      console.log('❌ Invalid report data');
      await sendTelegramMessage(
        chat_id,
        botToken,
        '❌ بيانات التقرير غير صحيحة. الرجاء المحاولة مرة أخرى.'
      );
      return new Response('Invalid report data', { status: 400 });
    }

    console.log('✅ Starting report processing...');

    // Process the report
    await processFullReport(
      chat_id,
      botToken,
      db,
      settings,
      api_key,
      reportData,
      userAnswers || {}
    );

    console.log('🧹 Cleaning up stored data...');

    // Clean up stored data - FIXED: Use op.eq() for filter
    await db.delete('conversation_state', {
      chat_id: op.eq(storageKey)
    });

    console.log('✅ Report processing complete for chat', chat_id);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('💥 Report processing error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Process full report with AI analysis
 */
async function processFullReport(
  chatId: string,
  botToken: string,
  db: SupabaseClient,
  settings: SettingsManager,
  apiKey: string,
  reportData: any,
  userAnswers: Record<string, string>
): Promise<void> {
  try {
    console.log('🤖 processFullReport started');

    // Send status
    await sendTelegramMessage(chatId, botToken, '🤖 جاري التحليل بالذكاء الاصطناعي...');
    console.log('📤 Status message sent');

    // Validate API key
    if (!apiKey.startsWith('sk-or-v1-')) {
      console.log('❌ Invalid API key format');
      await sendTelegramMessage(chatId, botToken, '❌ OpenRouter API key غير صحيح');
      return;
    }

    // Get AI model
    const aiModel = await settings.get('ai_model') || 'anthropic/claude-sonnet-4';
    console.log('🎯 AI Model:', aiModel);

    // Create services
    console.log('🏗️ Creating services...');
    const reportGen = createReportGenerator(db, settings);
    const aiClient = createAIClient(apiKey, aiModel);
    const memoryMgr = createMemoryManager(db, aiClient);

    // Generate past week summary
    console.log('📅 Generating past week summary...');
    const pastWeekSummary = reportGen.generatePastWeekSummary(reportData.previousReports || []);

    console.log('🤖 Calling AI for analysis (this may take 15-30 seconds)...');
    const startTime = Date.now();

    // Call AI for unified analysis (this is the slow part - 15-30 seconds)
    const aiResponse = await aiClient.generateDailyReport({
      reportDate: reportData.date,
      tasks: reportData.tasks,
      streaks: reportData.streaks,
      weeklyGoals: reportData.weeklyGoals?.goals_text || null,
      dailyChallenge: reportData.dailyChallenge?.challenge_text || null,
      memory: reportData.memory,
      pastWeekSummary,
      strategicGoals: reportData.strategicGoals,
      userAnswers: Object.keys(userAnswers).length > 0 ? userAnswers : undefined,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ AI analysis complete in ${elapsed}s`);

    // Send AI commentary
    console.log('📤 Sending commentary...');
    await sendTelegramMessage(chatId, botToken, '💬 *التحليل والتعليق:*');
    await sendLongTelegramMessage(chatId, botToken, aiResponse.mainCommentary);

    // Send challenge evaluation
    if (reportData.dailyChallenge) {
      console.log('📤 Sending challenge evaluation...');
      await sendTelegramMessage(
        chatId,
        botToken,
        `🎯 *تقييم التحدي اليومي:* ${aiResponse.challengeEvaluation}\n` +
        `"${reportData.dailyChallenge.challenge_text}"`
      );
    }

    // Send reward suggestion
    if (aiResponse.reward) {
      console.log('📤 Sending reward...');
      await sendTelegramMessage(chatId, botToken, `🎁 *المكافأة المقترحة:* ${aiResponse.reward}`);
    }

    // Send goals analysis
    if (aiResponse.goalsAnalysis) {
      console.log('📤 Sending goals analysis...');
      let goalsMsg = '🎯 *تحليل الأهداف الأسبوعية:*\n\n';

      if (aiResponse.goalsAnalysis.completed.length > 0) {
        goalsMsg += '✅ *منجزة:*\n';
        aiResponse.goalsAnalysis.completed.forEach(g => goalsMsg += `- ${g}\n`);
        goalsMsg += '\n';
      }

      if (aiResponse.goalsAnalysis.inProgress.length > 0) {
        goalsMsg += '🔄 *قيد التنفيذ:*\n';
        aiResponse.goalsAnalysis.inProgress.forEach(g => goalsMsg += `- ${g}\n`);
        goalsMsg += '\n';
      }

      if (aiResponse.goalsAnalysis.neglected.length > 0) {
        goalsMsg += '⚠️ *مهملة:*\n';
        aiResponse.goalsAnalysis.neglected.forEach(g => goalsMsg += `- ${g}\n`);
      }

      await sendTelegramMessage(chatId, botToken, goalsMsg);
    }

    // Update memory
    if (Object.keys(aiResponse.memoryUpdates).length > 0) {
      console.log('🧠 Updating memory...');
      await sendTelegramMessage(chatId, botToken, '🧠 جاري تحديث الذاكرة...');
      await memoryMgr.updateMemory(aiResponse.memoryUpdates);
      await sendTelegramMessage(chatId, botToken, '✅ تم تحديث الذاكرة');
    }

    // Check if memory optimization is needed
    if (aiResponse.memoryOptimization === 'OPTIMIZE_NEEDED') {
      console.log('🔄 Optimizing memory...');
      await sendTelegramMessage(chatId, botToken, '🔄 جاري تحسين الذاكرة...');
      await memoryMgr.checkOptimizationTriggers();
    }

    // Save report to database
    console.log('💾 Saving report to database...');
    await sendTelegramMessage(chatId, botToken, '💾 جاري حفظ التقرير...');
    const stats = reportGen.calculateStatistics(reportData.tasks);

    await db.insert('daily_reports', {
      report_date: reportData.date,
      report_markdown: aiResponse.mainCommentary,
      success_rate: stats.success_rate,
      total_tasks: stats.total_tasks,
      completed_tasks: stats.completed_tasks,
      failed_tasks: stats.failed_tasks,
      achievement_time_minutes: stats.total_time_minutes,
      challenge_evaluation: aiResponse.challengeEvaluation,
      ai_commentary: aiResponse.mainCommentary,
      suggested_reward: aiResponse.reward,
      weekly_goals_analysis: JSON.stringify(aiResponse.goalsAnalysis),
    });

    console.log('✅ Report saved to database');
    await sendTelegramMessage(chatId, botToken, '✅ تم حفظ التقرير بنجاح!');

    console.log('🎉 All done!');

  } catch (error) {
    console.error('💥 Report processing error:', error);
    console.error('Error stack:', (error as Error).stack);
    await sendTelegramMessage(
      chatId,
      botToken,
      '❌ حدث خطأ أثناء معالجة التقرير:\n' + (error as Error).message
    );
    throw error;
  }
}

/**
 * Send message via Telegram API directly
 */
async function sendTelegramMessage(
  chatId: string,
  botToken: string,
  text: string
): Promise<void> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Telegram API error:', error);
    } else {
      console.log('✅ Message sent successfully');
    }
  } catch (error) {
    console.error('💥 Failed to send Telegram message:', error);
    throw error;
  }
}

/**
 * Send long message with splitting
 */
async function sendLongTelegramMessage(
  chatId: string,
  botToken: string,
  text: string
): Promise<void> {
  const MAX_LENGTH = 4096;

  if (text.length <= MAX_LENGTH) {
    await sendTelegramMessage(chatId, botToken, text);
    return;
  }

  console.log(`📏 Message too long (${text.length} chars), splitting...`);

  // Split at paragraph breaks
  const parts: string[] = [];
  let currentPart = '';
  const lines = text.split('\n');

  for (const line of lines) {
    if (currentPart.length + line.length + 1 > MAX_LENGTH) {
      parts.push(currentPart);
      currentPart = line + '\n';
    } else {
      currentPart += line + '\n';
    }
  }

  if (currentPart) {
    parts.push(currentPart);
  }

  console.log(`📦 Split into ${parts.length} parts`);

  // Send all parts with small delay
  for (let i = 0; i < parts.length; i++) {
    console.log(`📤 Sending part ${i + 1}/${parts.length}`);
    await sendTelegramMessage(chatId, botToken, parts[i] || '');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}