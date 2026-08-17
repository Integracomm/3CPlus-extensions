// src/lib/events.js
// Copia de src/socket/SocketEvents.ts do SDK.

export const EV = {
  // Conexao
  AGENT_IS_CONNECTED: 'agent-is-connected',

  // Login / logout
  AGENT_IS_IDLE: 'agent-is-idle',
  AGENT_IS_ACW: 'agent-is-acw',
  AGENT_LOGIN_FAILED: 'agent-login-failed',
  AGENT_WAS_LOGGED_OUT: 'agent-was-logged-out',

  // Modo manual
  AGENT_ENTERED_MANUAL: 'agent-entered-manual',
  AGENT_MANUAL_ENTER_FAILED: 'agent-manual-enter-failed',

  // Chamadas
  CALL_WAS_CONNECTED: 'call-was-connected',
  CALL_WAS_FINISHED: 'call-was-finished',
  CALL_WAS_NOT_ANSWERED: 'call-was-not-answered',
  CALL_WAS_FAILED: 'call-was-failed',

  // Qualificacao
  MANUAL_CALL_WAS_ANSWERED: 'manual-call-was-answered',
  CALL_HISTORY_WAS_CREATED: 'call-history-was-created',

  // Intervalos
  AGENT_ENTERED_WORK_BREAK: 'agent-entered-work-break',
  AGENT_LEFT_WORK_BREAK: 'agent-left-work-break',

  // Erros genericos
  ERROR: 'error',
  EXCEPTION: 'exception'
};

/**
 * Valores de agent.status que aparecem nos eventos do socket.
 * Referencia copiada de web/app.js.
 */
export const AGENT_STATUS = {
  0: 'OFFLINE',
  1: 'IDLE',
  2: 'ON_CALL',
  3: 'ACW',
  4: 'ON_MANUAL_CALL',
  5: 'ON_MANUAL_CALL_CONNECTED',
  6: 'ON_WORK_BREAK',
  21: 'ON_MANUAL_CALL_ACW'
};
