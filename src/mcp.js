// Web Model Context Protocol (MCP) Integration
// Exposes browser agent tools via document.modelContext.registerTool

export function registerResonanceMCP(stateAccessor) {
  const modelContext = document.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') {
    return () => {};
  }

  const controller = new AbortController();
  const register = (tool) => {
    try {
      Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch(() => {});
    } catch {}
  };

  // 1. Read session state
  register({
    name: 'read_session_state',
    description: 'Read current neurofeedback session state, protocol, active target, electrode quality, pulse summary (heart rate, RMSSD, coherence) and breathing pacer. Does not expose raw EEG or PPG. Coherence is withheld during blinded sessions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const s = stateAccessor.getState();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mode: s.mode,
            phase: s.phase,
            protocol: s.protocol,
            target: s.target,
            score: s.score,
            timeInZonePct: s.timeInZonePct,
            currentStreak: s.currentStreak,
            bestStreak: s.bestStreak,
            electrodeQuality: s.electrodeQuality,
            heart: s.heart,
            pacer: s.pacer,
            alphaPeakHz: s.alphaPeakHz,
            personalBands: s.personalBands
          }, null, 2)
        }]
      };
    }
  });

  // 2. Configure protocol
  register({
    name: 'configure_protocol',
    description: 'Load a built-in neurofeedback protocol preset. The recorded baseline is kept.',
    inputSchema: {
      type: 'object',
      properties: {
        protocol: { type: 'string', enum: ['calm', 'sharpen', 'settle', 'deep', 'peak', 'balance', 'triad', 'breath', 'heartmind'] }
      },
      required: ['protocol'],
      additionalProperties: false
    },
    handler: async (args) => {
      const ok = stateAccessor.setProtocol(args.protocol);
      return { content: [{ type: 'text', text: ok ? `Protocol set to ${args.protocol}` : `Unknown protocol ${args.protocol}` }] };
    }
  });

  // 3. Configure simulation
  register({
    name: 'configure_simulation',
    description: 'Configure synthetic EEG generator mental state, intensity, and stability for automated testing.',
    inputSchema: {
      type: 'object',
      properties: {
        mentalState: { type: 'string', enum: ['calm', 'focus', 'deep', 'restless', 'drowsy'] },
        intensity: { type: 'number', minimum: 0, maximum: 1 },
        stability: { type: 'number', minimum: 0, maximum: 1 }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      stateAccessor.setSimulation(args);
      return { content: [{ type: 'text', text: `Simulation updated: ${JSON.stringify(args)}` }] };
    }
  });

  return () => {
    controller.abort();
  };
}
