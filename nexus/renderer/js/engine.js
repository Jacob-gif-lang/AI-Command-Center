'use strict';
/**
 * 流程执行引擎（Flow Engine）
 * ------------------------------------------------------------
 * 图模型：有向图，节点带类型，边带端口（out / true / false / body / exit）。
 * 执行方式：从「输入节点」出发深度优先；判断节点按条件只走一条分支；
 *           循环节点对其 body 分支做迭代，回边（body 终点指回循环节点）被识别为一次迭代结束。
 *
 * 为什么放在渲染层而不是主进程：
 *   v0.1 需要节点执行过程实时驱动 UI（高亮、逐字、连线动画），放在同一事件循环最省一次 IPC 往返。
 *   待流程需要「关掉窗口也继续跑」时，把本文件原样搬到 server/orchestrator.js，
 *   把 emit 换成 SSE 即可 —— 契约（事件名 / 节点语义）保持不变。
 */
(function () {
  const S = window.NexusState;
  const API = window.NexusAPI;

  function outEdges(flow, nodeId, port) {
    return (flow.edges || []).filter((e) => e.from === nodeId && (e.port || 'out') === port);
  }

  /** 用户自写的本地表达式，仅作用于本机画布数据，不接收远端输入 */
  function evalCondition(expr, ctx) {
    if (!expr || !String(expr).trim()) return Boolean(ctx.last);
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('result', 'round', 'input', `return (${expr});`);
      return Boolean(fn(ctx.last, ctx.iteration || 1, ctx.input));
    } catch (err) {
      return Boolean(ctx.last);
    }
  }

  async function runFlow(flow, opts = {}) {
    const emit = opts.onEvent || (() => {});
    const signal = opts.signal;
    const byId = new Map((flow.nodes || []).map((n) => [n.id, n]));
    const ctx = {
      input: opts.input || '',
      last: '',
      iteration: 0,
      steps: 0,
      maxSteps: opts.maxSteps || 200,
      activeLoops: [],
      outputs: []
    };

    const start =
      (flow.nodes || []).find((n) => n.type === 'input') ||
      (flow.nodes || []).find((n) => !(flow.edges || []).some((e) => e.to === n.id)) ||
      (flow.nodes || [])[0];

    if (!start) throw new Error('画布为空，先添加节点');

    emit({ type: 'flow-start', text: '流程开始' });

    async function visit(nodeId) {
      const node = byId.get(nodeId);
      if (!node) return;
      if (signal && signal.aborted) throw new Error('已取消');
      if (++ctx.steps > ctx.maxSteps) throw new Error(`超过最大执行步数 ${ctx.maxSteps}，可能存在死循环`);

      // 回边打入正在迭代的循环节点 → 本次迭代结束
      const active = ctx.activeLoops.find((l) => l.nodeId === nodeId);
      if (active) { active.reentered = true; return; }

      emit({ type: 'node-start', nodeId, nodeType: node.type, title: node.title });

      switch (node.type) {
        case 'input': {
          ctx.last = ctx.input;
          emit({ type: 'node-done', nodeId, text: ctx.last.slice(0, 160) });
          for (const e of outEdges(flow, nodeId, 'out')) {
            emit({ type: 'edge-active', edgeId: e.id });
            await visit(e.to);
          }
          return;
        }

        case 'ai': {
          const providerId = node.config.providerId || (S.autoPick() || {}).id || 'demo';
          const provider = S.providerById(providerId) || { id: 'demo', name: 'Demo' };
          const model = node.config.model || (S.state.models[providerId]) || (provider.models && provider.models[0] && provider.models[0].id) || undefined;
          const prompt = String(node.config.prompt || '')
            .replace(/\{\{\s*input\s*\}\}/g, ctx.input)
            .replace(/\{\{\s*last\s*\}\}/g, ctx.last);

          emit({ type: 'log', text: `${node.title} → ${provider.name}${model ? ' / ' + model : ''}` });
          let acc = '';
          try {
            await API.chat({
              providerId,
              model,
              messages: [
                { role: 'system', content: node.config.system || '你是流程中的一个执行节点，直接输出结果本身，不要寒暄、不要复述任务。' },
                { role: 'user', content: prompt || ctx.last || ctx.input || '请输出一句确认。' }
              ],
              signal,
              onDelta: (t) => {
                acc += t;
                emit({ type: 'node-delta', nodeId, text: acc });
              }
            });
            ctx.last = acc.trim() || '（空响应）';
            emit({ type: 'node-done', nodeId, text: ctx.last.slice(0, 160) });
          } catch (err) {
            emit({ type: 'node-error', nodeId, text: err.message || String(err), hint: err.hint });
            throw err;
          }
          for (const e of outEdges(flow, nodeId, 'out')) {
            emit({ type: 'edge-active', edgeId: e.id });
            await visit(e.to);
          }
          return;
        }

        case 'judge': {
          const result = evalCondition(node.config.condition, ctx);
          emit({ type: 'log', text: `判断「${node.config.condition || 'result'}」→ ${result ? '真' : '假'}` });
          emit({ type: 'node-done', nodeId, text: result ? 'TRUE' : 'FALSE' });
          const port = result ? 'true' : 'false';
          for (const e of outEdges(flow, nodeId, port)) {
            emit({ type: 'edge-active', edgeId: e.id });
            await visit(e.to);
          }
          return;
        }

        case 'loop': {
          const times = Math.max(1, Math.min(12, Number(node.config.iterations) || 2));
          for (let i = 1; i <= times; i++) {
            ctx.iteration = i;
            emit({ type: 'log', text: `循环 ${i}/${times} 开始` });
            const entry = { nodeId, iter: i, reentered: false };
            ctx.activeLoops.push(entry);
            const bodies = outEdges(flow, nodeId, 'body');
            if (!bodies.length) {
              ctx.activeLoops.pop();
              emit({ type: 'log', text: '循环体未连线，跳过' });
              break;
            }
            emit({ type: 'edge-active', edgeId: bodies[0].id });
            await visit(bodies[0].to);
            ctx.activeLoops.pop();
            emit({ type: 'node-done', nodeId, text: `第 ${i} 轮完成` });
            if (node.config.condition && evalCondition(node.config.condition, ctx)) {
              emit({ type: 'log', text: `退出条件满足：${node.config.condition}` });
              break;
            }
          }
          for (const e of outEdges(flow, nodeId, 'exit')) {
            emit({ type: 'edge-active', edgeId: e.id });
            await visit(e.to);
          }
          return;
        }

        case 'output': {
          ctx.outputs.push(ctx.last);
          emit({ type: 'node-done', nodeId, text: ctx.last.slice(0, 200) });
          emit({ type: 'flow-output', text: ctx.last, nodeId });
          return;
        }

        default:
          emit({ type: 'log', text: `未知节点类型 ${node.type}` });
      }
    }

    try {
      await visit(start.id);
      emit({ type: 'flow-done', text: ctx.outputs.join('\n\n') || ctx.last, steps: ctx.steps });
      return { text: ctx.outputs.join('\n\n') || ctx.last, steps: ctx.steps };
    } catch (err) {
      emit({ type: 'flow-error', text: err.message || String(err) });
      throw err;
    }
  }

  window.NexusEngine = { runFlow };
})();
