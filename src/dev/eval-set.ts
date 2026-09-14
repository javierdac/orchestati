import type { Intent } from '../core/types.js';

/**
 * Set de evaluacion. Ninguna de estas frases esta en los prototipos:
 * si el clasificador acierta es porque generalizo, no porque memorizo.
 */
export interface EvalCase {
  text: string;
  expected: Intent;
}

export const EVAL_SET: EvalCase[] = [
  // Conversacional
  { text: 'holaa', expected: 'greeting' },
  { text: 'buen dia', expected: 'greeting' },
  { text: 'que hacés', expected: 'greeting' },
  { text: 'nos vemos mañana', expected: 'farewell' },
  { text: 'listo, me voy', expected: 'farewell' },
  { text: 'gracias por todo', expected: 'thanks' },
  { text: 'de diez, muchas gracias', expected: 'thanks' },
  { text: 'y vos que contás', expected: 'smalltalk' },
  { text: 'que cosas sabés hacer', expected: 'identity' },
  { text: 'para que fuiste hecho', expected: 'identity' },

  // Preguntas y how-to
  { text: 'que es un mutex', expected: 'factual_qa' },
  { text: 'cual es la diferencia entre map y forEach', expected: 'factual_qa' },
  { text: 'en que lenguaje esta escrito git', expected: 'factual_qa' },
  { text: 'que significa el flag -rf', expected: 'factual_qa' },
  { text: 'como hago para que corra en background', expected: 'howto' },
  { text: 'necesito saber como conectar dos containers', expected: 'howto' },
  { text: 'por donde arranco para aprender rust', expected: 'howto' },

  // Codigo
  { text: 'me armas una funcion que valide un cuit', expected: 'code_generate' },
  { text: 'necesito un middleware de logging para express', expected: 'code_generate' },
  { text: 'quiero un script en bash que comprima logs viejos', expected: 'code_generate' },
  { text: 'dame el tipo typescript para esta respuesta de la api', expected: 'code_generate' },
  { text: 'podrias escribir los tests de este modulo', expected: 'code_generate' },

  { text: 'me tira null pointer y no entiendo donde', expected: 'code_debug' },
  { text: 'el endpoint devuelve 404 pero la ruta existe', expected: 'code_debug' },
  { text: 'se rompe solo cuando hay muchos usuarios', expected: 'code_debug' },
  { text: 'TypeError: cannot read properties of undefined (reading id)', expected: 'code_debug' },
  { text: 'el docker build queda colgado en el paso 3', expected: 'code_debug' },
  { text: 'esto funcionaba y despues de actualizar dejo de andar', expected: 'code_debug' },
  { text: 'tengo un deadlock en la base y no se por que', expected: 'code_debug' },

  { text: 'que hace este regex', expected: 'code_explain' },
  { text: 'explicame esta clase', expected: 'code_explain' },
  { text: 'no me queda claro para que esta este wrapper', expected: 'code_explain' },
  { text: 'contame que hace src/router/router.ts', expected: 'code_explain' },

  { text: 'esto se puede escribir mas simple', expected: 'refactor' },
  { text: 'hay codigo repetido en estos tres archivos', expected: 'refactor' },
  { text: 'convertí estas callbacks a promesas', expected: 'refactor' },
  { text: 'separá la logica de negocio de la vista', expected: 'refactor' },

  // Investigacion y planificacion
  { text: 'que conviene usar para colas de mensajes', expected: 'research' },
  { text: 'comparame kafka contra rabbitmq', expected: 'research' },
  { text: 'necesito saber que alternativas hay a firebase', expected: 'research' },
  { text: 'nos sirve mas monolito o microservicios', expected: 'research' },

  { text: 'armemos un plan para migrar a la nube', expected: 'planning' },
  { text: 'como organizamos el trabajo del sprint', expected: 'planning' },
  { text: 'necesito definir las etapas del proyecto', expected: 'planning' },
  { text: 'que estructura le damos al sistema nuevo', expected: 'planning' },

  // Numeros y datos
  { text: 'cuanto es 340 mas 1200 dividido 3', expected: 'math' },
  { text: 'sacame el 21 por ciento de este monto', expected: 'math' },
  { text: 'necesito el desvio estandar de estos valores', expected: 'math' },
  { text: 'que tendencia muestran las ventas del semestre', expected: 'data_analysis' },
  { text: 'hay alguna relacion entre estas dos metricas', expected: 'data_analysis' },
  { text: 'analizame los numeros de conversion', expected: 'data_analysis' },

  // Texto
  { text: 'pasalo a ingles por favor', expected: 'translate' },
  { text: 'como se escribe esto en aleman', expected: 'translate' },
  { text: 'achicame este texto a la mitad', expected: 'summarize' },
  { text: 'dame lo esencial de este documento', expected: 'summarize' },
  { text: 'necesito un slogan para la campaña', expected: 'creative' },
  { text: 'tirame ideas de nombres para el proyecto', expected: 'creative' },
  { text: 'escribime un mail de presentacion', expected: 'creative' },

  // Acciones
  { text: 'publicá la version nueva', expected: 'tool_action' },
  { text: 'borrame los archivos temporales', expected: 'tool_action' },
  { text: 'ejecutá el suite de tests', expected: 'tool_action' },
  { text: 'fijate si compila', expected: 'tool_action' },
];
