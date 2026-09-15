/**
 * Pedidos para comparar calidad entre el escalon ruteado y mandar todo al
 * modelo caro.
 *
 * Son autocontenidos a proposito: un pedido como "resumime este texto" no
 * sirve para juzgar calidad si no viene el texto, porque las dos respuestas
 * serian igual de inutiles y el juez estaria comparando ruido.
 */
export interface QualityCase {
  text: string;
  /** Que tendria que tener una respuesta aceptable. Se le pasa al juez. */
  criteria: string;
}

export const QUALITY_SET: QualityCase[] = [
  {
    text: 'hola',
    criteria: 'Saluda de vuelta y ofrece ayuda. No debe inventar contexto ni dar una parrafada.',
  },
  {
    text: 'gracias, me sirvio',
    criteria: 'Reconoce el agradecimiento brevemente. No debe agregar contenido no pedido.',
  },
  {
    text: 'que es un closure en javascript',
    criteria: 'Define closure: una funcion que retiene acceso al scope donde fue creada. Idealmente un ejemplo.',
  },
  {
    text: 'cual es la diferencia entre let y var en javascript',
    criteria: 'Menciona el scope de bloque vs funcion. Idealmente hoisting o la temporal dead zone.',
  },
  {
    text: 'como se dice "buenas noches" en aleman',
    criteria: 'Da la traduccion correcta ("Gute Nacht" o "Guten Abend" con la distincion).',
  },
  {
    text: 'cuanto es (2340 * 15) / 100',
    criteria: 'El resultado es exactamente 351.',
  },
  {
    text: 'si un producto cuesta 4500 y le aplico 18% de descuento, cuanto queda',
    criteria: 'El resultado es 3690. Debe mostrar o implicar el calculo.',
  },
  {
    text: 'escribime una funcion typescript que valide si un string es un email',
    criteria: 'Codigo typescript sintacticamente valido, con tipos, que valide un email. Debe ser ejecutable.',
  },
  {
    text: 'escribime una funcion en python que reciba una lista de numeros y devuelva la mediana',
    criteria: 'Codigo python correcto que ordene y maneje el caso de longitud par promediando los dos centrales.',
  },
  {
    text: 'explicame que hace el metodo reduce de los arrays en javascript',
    criteria: 'Explica el acumulador, la funcion reductora y el valor inicial. Idealmente un ejemplo.',
  },
  {
    text: 'tengo un memory leak en un servidor node que crece durante horas, por donde empiezo a buscar',
    criteria: 'Propone pasos concretos de diagnostico: heap snapshots, sospechosos habituales (listeners, cachés, closures retenidos), como confirmar.',
  },
  {
    text: 'el mismo endpoint responde en 20ms en local y timeout en produccion, que puede estar pasando',
    criteria: 'Plantea hipotesis diferenciadas de entorno: latencia de red o base, pool de conexiones, DNS, cold start, datos de distinto volumen. Debe razonar, no listar genericos.',
  },
  {
    text: 'conviene usar postgres o mongodb para un sistema de facturacion, y por que',
    criteria: 'Se inclina por una con criterios explicitos (transacciones, integridad referencial, esquema estable). Debe tomar posicion, no enumerar y lavarse las manos.',
  },
  {
    text: 'disename la arquitectura de un acortador de urls que soporte 10 mil peticiones por segundo',
    criteria: 'Cubre generacion de ids, almacenamiento, caché de lecturas y por que esas elecciones aguantan ese trafico.',
  },
];
