import type { ConfirmationDecision, ConfirmationPolicy, ConfirmationRequest } from './types.js';

/**
 * Politicas de confirmacion. El default del orquestador es el mas conservador
 * que sigue siendo util: lee sin preguntar, no escribe nada sin permiso.
 */

/** Aprueba solo lo que no tiene efectos. Default. */
export function autoSafe(): ConfirmationPolicy {
  return {
    name: 'auto-safe',
    async confirm(req: ConfirmationRequest): Promise<ConfirmationDecision> {
      if (req.risk === 'safe') return { approved: true };
      return {
        approved: false,
        reason: 'la politica activa solo permite herramientas de lectura',
      };
    },
  };
}

/** Rechaza todo. Util para inspeccionar que *haria* un agente. */
export function denyAll(): ConfirmationPolicy {
  return {
    name: 'deny-all',
    async confirm(): Promise<ConfirmationDecision> {
      return { approved: false, reason: 'herramientas deshabilitadas' };
    },
  };
}

/**
 * Aprueba todo sin preguntar. Solo para entornos automatizados donde la
 * autorizacion ya se dio afuera: nunca es el default.
 */
export function allowAll(): ConfirmationPolicy {
  return {
    name: 'allow-all',
    async confirm(): Promise<ConfirmationDecision> {
      return { approved: true };
    },
  };
}

/**
 * Le pregunta a alguien. Lo `safe` pasa directo; el resto va al callback.
 * Lo `destructive` se le muestra siempre, aunque el callback sea automatico.
 */
export function askUser(
  ask: (req: ConfirmationRequest) => Promise<boolean>,
): ConfirmationPolicy {
  return {
    name: 'ask-user',
    async confirm(req: ConfirmationRequest): Promise<ConfirmationDecision> {
      if (req.risk === 'safe') return { approved: true };
      const ok = await ask(req);
      return ok ? { approved: true } : { approved: false, reason: 'el usuario no lo autorizo' };
    },
  };
}
