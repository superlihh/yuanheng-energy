(function () {
  'use strict';

  /* 适配层只约定输入输出，后续可替换为企业内网模型、私有部署模型或规则服务。 */
  const localAnswer = (question, context) => ({
    answer: '当前问答服务暂不可用，已保留问题条件：' + context.region + ' / ' + context.time + ' / ' + context.metric + '。请稍后重试或查看运行态势。',
    evidence: [], mode: 'local', model: '本地规则分析', chart: false, source: '当前授权数据'
  });

  function normalizeResult(result, question) {
    const value = result || {};
    const sources = Array.isArray(value.sources) ? value.sources : [];
    return Object.assign({}, value, {
      answer: value.answer || '当前没有可显示的回答。',
      evidence: sources,
      source: sources.map(item => item.name || item.source || '授权数据').slice(0, 4).join('；') || '当前企业授权数据',
      mode: value.mode || 'model',
      model: value.model || 'qwen3.7-plus',
      chart: value.chart || (/趋势|变化|对比|过去|近\d+天|昨天|上周/.test(question) ? { type: 'line' } : null)
    });
  }

  function csvHeaders(text) {
    const first = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim());
    if (!first) return [];
    const delimiter = first.indexOf(';') > -1 && first.indexOf(',') === -1 ? ';' : ',';
    return first.split(delimiter).map(item => item.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }

  window.YUANHENG_ASSISTANT_ADAPTER = {
    async ask(question, context, history, signal, onDelta) {
      if (!window.YUANHENG_LIVE || !window.YUANHENG_LIVE.request) return localAnswer(question, context);
      const prior = [...(history || [])].slice(-8);
      if (prior.length && prior[prior.length - 1].role === 'user' && prior[prior.length - 1].content === question) prior.pop();
      // Keep the UI's short ``time`` label while sending the API contract's
      // explicit ``timeRange`` field. The backend accepts both for older
      // clients, but the canonical field avoids silently querying today's data
      // for a "近7天" or "近30天" question.
      const apiContext = Object.assign({}, context, {
        timeRange: context.timeRange || context.time || '今日',
        granularity: context.granularity || '小时'
      });
      // Use the stable JSON response path in the main assistant. The SSE path
      // is useful for experiments, but a broken stream can make a healthy
      // model call look like an unavailable AI service in the UI.
      const body = { messages: [...prior, { role: 'user', content: question }], conversationId: context.sessionId || '', context: apiContext, stream: false };
      try {
        const result = await window.YUANHENG_LIVE.request('/api/ai/chat', { method: 'POST', signal, body });
        return normalizeResult(result, question);
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        // Do not silently call the legacy /api/ask endpoint. It can answer from
        // a frozen demo plan and make a failed AI request look successful.
        return normalizeResult({
          answer: 'AI服务请求失败：' + (error && error.message ? error.message : '未返回具体错误') + '。本次没有生成模型分析。',
          summary: 'AI服务不可用', facts: [], analysis: [],
          risks: ['本次未形成可靠的模型结论'],
          suggestions: ['检查AI服务状态', '确认当前账号已导入数据'],
          sources: [], confidence: 0, needHumanReview: true, chart: null,
          mode: 'error', model: 'unavailable', error: error && error.message ? error.message : 'AI_REQUEST_FAILED', status: error && error.status
        }, question);
      }
    },
    async inspectFile(file, text) {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      const headers = isCsv ? csvHeaders(text) : [];
      const lines = isCsv ? String(text || '').split(/\r?\n/).filter(line => line.trim()) : [];
      return {
        filename: file.name,
        type: file.type || '未知类型',
        size: file.size,
        rows: Math.max(0, lines.length - 1),
        headers,
        status: isCsv ? '可预览' : '等待解析适配器',
        note: isCsv ? '已识别文本表格，可在确认后导入。' : '文件已登记，需部署对应解析适配器后再导入。'
      };
    }
  };
})();
