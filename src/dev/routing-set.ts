import type { Tier } from '../core/types.js';

/**
 * Set de evaluacion del RUTEO.
 *
 * Hasta ahora el proyecto media la clasificacion de intencion —un componente—
 * y la decision de ruteo, que es el producto, se miraba a ojo en una tabla.
 * Esto la mide.
 *
 * Estas frases son nuevas: no son las de la tabla de calibracion, contra las
 * que si se ajustaron los umbrales. El numero que den es el numero que hay.
 */
export interface RoutingCase {
  text: string;
  /** Escalon que corresponde. */
  tier: Tier;
  /** Agentes aceptables como principal. Vacio = no se evalua el agente. */
  agents?: string[];
  /** Por que corresponde ese escalon. */
  why: string;
}

export const ROUTING_SET: RoutingCase[] = [
  // --- reflex: conversacion pura, sin trabajo que hacer ---------------------
  { text: 'buenas!', tier: 'reflex', agents: ['reflex.smalltalk'], why: 'saludo suelto' },
  { text: 'hey there', tier: 'reflex', agents: ['reflex.smalltalk'], why: 'saludo suelto' },
  { text: 'listo, gracias', tier: 'reflex', agents: ['reflex.smalltalk'], why: 'agradecimiento' },
  { text: 'perfect, thanks a lot', tier: 'reflex', agents: ['reflex.smalltalk'], why: 'agradecimiento' },
  { text: 'nos vemos', tier: 'reflex', agents: ['reflex.smalltalk'], why: 'despedida' },
  { text: 'que cosas sabes hacer', tier: 'reflex', agents: ['reflex.identity'], why: 'pregunta sobre el sistema' },

  // --- light: respuesta corta, sin herramientas ni razonamiento ------------
  { text: 'que significa API', tier: 'light', agents: ['llm.quick'], why: 'definicion de una linea' },
  { text: 'what does JSON stand for', tier: 'light', agents: ['llm.quick'], why: 'definicion de una linea' },
  { text: 'cual es la capital de noruega', tier: 'light', agents: ['llm.quick'], why: 'dato puntual' },
  { text: 'como se dice gato en aleman', tier: 'light', agents: ['llm.quick'], why: 'traduccion de una palabra' },
  { text: 'en que año salio python', tier: 'light', agents: ['llm.quick'], why: 'dato puntual' },

  // --- standard: trabajo real acotado --------------------------------------
  { text: 'escribime una funcion que ordene un array de objetos por fecha', tier: 'standard', agents: ['llm.coder'], why: 'codigo acotado' },
  { text: 'write a python function that retries an http call three times', tier: 'standard', agents: ['llm.coder'], why: 'codigo acotado' },
  { text: 'necesito un regex que valide un numero de telefono argentino', tier: 'standard', agents: ['llm.coder'], why: 'codigo acotado' },
  { text: 'cuanto es 1450 dividido 12', tier: 'standard', agents: ['llm.analyst'], why: 'calculo' },
  { text: 'sacame el 18% de 7200', tier: 'standard', agents: ['llm.analyst'], why: 'calculo' },
  { text: 'resumime este texto en tres bullets', tier: 'standard', agents: ['llm.writer'], why: 'redaccion acotada' },
  { text: 'escribime un tweet anunciando la version 2.0', tier: 'standard', agents: ['llm.writer'], why: 'redaccion acotada' },
  { text: 'corré los tests y decime si pasan', tier: 'standard', agents: ['llm.tools'], why: 'accion con efecto' },
  { text: 'hace un commit con los cambios', tier: 'standard', agents: ['llm.tools'], why: 'accion con efecto' },
  { text: 'borra la tabla de sesiones vieja', tier: 'standard', agents: ['llm.tools'], why: 'accion destructiva' },
  { text: 'explicame que hace la funcion reduce', tier: 'standard', agents: ['llm.coder', 'llm.quick'], why: 'explicacion de codigo simple' },

  // --- deep: requiere razonar, diagnosticar o disenar -----------------------
  { text: 'me da Segmentation fault al correr el binario y no se por donde empezar', tier: 'deep', agents: ['llm.debugger'], why: 'diagnostico de causa raiz' },
  { text: 'the request times out only in production, never locally', tier: 'deep', agents: ['llm.debugger'], why: 'diagnostico de causa raiz' },
  { text: 'tengo un memory leak que crece de a poco durante horas', tier: 'deep', agents: ['llm.debugger'], why: 'diagnostico de causa raiz' },
  { text: 'hay un race condition entre el worker y el scheduler', tier: 'deep', agents: ['llm.debugger'], why: 'diagnostico de causa raiz' },
  { text: 'disename el esquema de datos para un sistema de reservas con overbooking', tier: 'deep', agents: ['llm.planner', 'llm.researcher'], why: 'diseno de sistema' },
  { text: 'como estructuramos el proyecto para que escale a diez equipos', tier: 'deep', agents: ['llm.planner', 'llm.researcher'], why: 'diseno organizacional' },
  { text: 'que estrategia de caching nos conviene para este patron de trafico', tier: 'deep', agents: ['llm.researcher', 'llm.planner'], why: 'decision con trade-offs' },
  { text: 'compare event sourcing against a traditional crud model for our case', tier: 'deep', agents: ['llm.researcher'], why: 'comparacion con trade-offs' },

  // --- swarm: pesado Y multiple --------------------------------------------
  {
    text: 'analiza el estado actual del sistema de pagos, despues proponeme una arquitectura nueva y ademas estima cuanto costaria migrar',
    tier: 'swarm',
    why: 'tres tareas distintas y pesadas',
  },
  {
    text: 'research the available options for authentication, then design the migration and also estimate the effort in weeks',
    tier: 'swarm',
    why: 'tres tareas distintas y pesadas',
  },
  {
    text: 'revisa la performance actual, identifica los cuellos de botella y ademas armame un plan priorizado para resolverlos',
    tier: 'swarm',
    why: 'tres tareas distintas y pesadas',
  },
];
