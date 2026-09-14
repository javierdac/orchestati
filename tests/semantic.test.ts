import { describe, expect, it, vi } from 'vitest';
import {
  cosine,
  extractFeatures,
  hashFeature,
  IdfModel,
  vectorize,
} from '../src/analysis/semantic/vectorize.js';
import { NgramClassifier, type SemanticBackend } from '../src/analysis/semantic/classifier.js';
import { flatPrototypes } from '../src/analysis/semantic/prototypes.js';
import { arbitrate, SEMANTIC_FLOOR_FILL, SEMANTIC_FLOOR_OVERRIDE } from '../src/analysis/arbiter.js';
import { analyze } from '../src/analysis/analyzer.js';
import { normalize } from '../src/analysis/lexicon.js';
import { EVAL_SET } from '../src/dev/eval-set.js';
import type { ScoredIntent } from '../src/core/types.js';

const idfOn = (texts: string[]) => new IdfModel(texts.map(extractFeatures));
const vec = (text: string, idf: IdfModel) => vectorize(extractFeatures(text), idf);

describe('vectorizador', () => {
  it('es deterministico', () => {
    expect(hashFeature('refactor')).toBe(hashFeature('refactor'));
    expect(extractFeatures('hola mundo')).toEqual(extractFeatures('hola mundo'));
  });

  it('produce vectores de norma 1', () => {
    const idf = idfOn(['hola mundo', 'chau mundo']);
    const v = vec('hola mundo', idf);
    const norm = Math.sqrt([...v.values()].reduce((a, w) => a + w * w, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('el coseno de un vector consigo mismo es 1', () => {
    const idf = idfOn(['un texto cualquiera', 'otro distinto']);
    const v = vec('un texto cualquiera', idf);
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  it('acerca variantes morfologicas y separa lo que no tiene que ver', () => {
    const corpus = ['refactorizar el modulo', 'refactorizame esto', 'hola buenas tardes'];
    const idf = idfOn(corpus);
    const a = vec('refactorizar el modulo', idf);
    const b = vec('refactorizame esto', idf);
    const c = vec('hola buenas tardes', idf);

    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });

  it('tolera errores de tipeo, que es donde el lexico se rompe', () => {
    const idf = idfOn(['necesito refactorizar esto', 'quiero un cafe']);
    const bien = vec('necesito refactorizar esto', idf);
    const typo = vec('necesito refactorizr esto', idf);
    const otro = vec('quiero un cafe', idf);

    expect(cosine(bien, typo)).toBeGreaterThan(0.6);
    expect(cosine(bien, typo)).toBeGreaterThan(cosine(bien, otro));
  });

  it('el texto vacio no rompe nada', () => {
    const idf = idfOn(['algo']);
    expect(vec('', idf).size).toBe(0);
    expect(cosine(vec('', idf), vec('algo', idf))).toBe(0);
  });
});

describe('clasificador', () => {
  const clf = new NgramClassifier();

  it('clasifica bien sus propios prototipos', () => {
    const protos = flatPrototypes();
    const aciertos = protos.filter((p) => clf.classify(normalize(p.text))[0]?.intent === p.intent);
    // Sobre la data que vio tiene que estar practicamente perfecto.
    expect(aciertos.length / protos.length).toBeGreaterThan(0.95);
  });

  it('generaliza a frases que nunca vio', () => {
    expect(clf.classify(normalize('holaa'))[0]!.intent).toBe('greeting');
    expect(clf.classify(normalize('sacame el 21 por ciento de este monto'))[0]!.intent).toBe('math');
    expect(clf.classify(normalize('tengo un deadlock en la base y no se por que'))[0]!.intent).toBe('code_debug');
  });

  it('devuelve el prototipo mas parecido como evidencia auditable', () => {
    const top = clf.classify(normalize('holaa'))[0]!;
    expect(top.evidence[0]).toMatch(/^≈ "/);
  });

  it('ordena por score descendente', () => {
    const out = clf.classify(normalize('armame un plan para migrar'));
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.score).toBeLessThanOrEqual(out[i - 1]!.score);
    }
  });

  it('no explota con entrada vacia', () => {
    expect(clf.classify('')).toEqual([]);
  });
});

describe('arbitro', () => {
  const spy = (intents: ScoredIntent[]): SemanticBackend & { classify: ReturnType<typeof vi.fn> } => ({
    name: 'spy',
    classify: vi.fn(() => intents),
  });

  const lex = (intent: string, score: number): ScoredIntent[] => [
    { intent: intent as ScoredIntent['intent'], score, evidence: ['x'] },
  ];

  it('no consulta al semantico cuando el lexico esta seguro', () => {
    const s = spy([{ intent: 'refactor', score: 0.9, evidence: [] }]);
    const res = arbitrate('lo que sea', lex('code_debug', 2), 0.95, s);

    expect(s.classify).not.toHaveBeenCalled();
    expect(res.source).toBe('lexicon');
    expect(res.intents[0]!.intent).toBe('code_debug');
  });

  it('el semantico llena el hueco cuando el lexico no reconocio nada', () => {
    const s = spy([{ intent: 'research', score: SEMANTIC_FLOOR_FILL + 0.05, evidence: ['≈ "x"'] }]);
    const res = arbitrate('algo raro', lex('unknown', 0.2), 0.9, s);

    expect(res.source).toBe('semantic');
    expect(res.intents[0]!.intent).toBe('research');
  });

  it('si ninguno de los dos sabe, se admite no saber', () => {
    const s = spy([{ intent: 'research', score: SEMANTIC_FLOOR_FILL - 0.03, evidence: [] }]);
    const res = arbitrate('algo rarisimo', lex('unknown', 0.2), 0.9, s);

    expect(res.source).toBe('lexicon');
    expect(res.intents[0]!.intent).toBe('unknown');
    expect(res.confidence).toBeLessThan(0.3);
  });

  it('para dar vuelta al lexico la barra es mas alta que para rellenar', () => {
    const flojo = spy([{ intent: 'creative', score: SEMANTIC_FLOOR_FILL + 0.05, evidence: [] }]);
    const noDaVuelta = arbitrate('x', lex('code_generate', 1), 0.5, flojo);
    expect(noDaVuelta.intents[0]!.intent).toBe('code_generate');
    // Pero el desacuerdo baja la confianza del lexico.
    expect(noDaVuelta.confidence).toBeLessThan(0.5);

    const firme = spy([
      { intent: 'creative', score: SEMANTIC_FLOOR_OVERRIDE + 0.1, evidence: [] },
      { intent: 'code_generate', score: 0.1, evidence: [] },
    ]);
    const daVuelta = arbitrate('x', lex('code_generate', 1), 0.5, firme);
    expect(daVuelta.intents[0]!.intent).toBe('creative');
    expect(daVuelta.source).toBe('semantic');
  });

  it('cuando coinciden sube la confianza', () => {
    const s = spy([{ intent: 'planning', score: 0.4, evidence: [] }]);
    const res = arbitrate('x', lex('planning', 1), 0.5, s);

    expect(res.source).toBe('merged');
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it('sin backend semantico se comporta como antes', () => {
    const res = arbitrate('x', lex('unknown', 0.2), 0.4, undefined);
    expect(res.source).toBe('lexicon');
    expect(res.confidence).toBe(0.4);
  });
});

describe('analizador con semantico', () => {
  it('se puede desactivar y queda solo el lexico', () => {
    const conSemantico = analyze('tirame ideas de nombres para el proyecto');
    const soloLexico = analyze('tirame ideas de nombres para el proyecto', { semantic: false });

    expect(conSemantico.primaryIntent).toBe('creative');
    expect(soloLexico.primaryIntent).toBe('unknown');
    expect(soloLexico.intentSource).toBe('lexicon');
  });

  it('deja auditar que dijo el semantico aunque no haya ganado', () => {
    const s = analyze('escribime una funcion que valide un email');
    expect(s.intentSource).toBe('lexicon');
    expect(s.primaryIntent).toBe('code_generate');
  });

  it('una intencion adivinada no puede activar el camino reflex', () => {
    // El clasificador le pega mal a esta frase y dice "farewell". Aun asi, no
    // puede terminar respondiendo "chau" a un pedido de refactor.
    const s = analyze('separá la logica de negocio de la vista');
    expect(s.confidence).toBeLessThan(0.6);
    expect(s.suggestedTier).not.toBe('reflex');
  });

  it('un saludo de verdad si llega a reflex', () => {
    const s = analyze('hola');
    expect(s.confidence).toBeGreaterThanOrEqual(0.6);
    expect(s.suggestedTier).toBe('reflex');
  });

  it('la complejidad de una intencion dudosa regresa hacia la media', () => {
    const seguro = analyze('hola');
    const adivinado = analyze('separá la logica de negocio de la vista');
    // Las dos dan intents de complejidad base 0 (greeting / farewell), pero
    // solo a la primera le creemos.
    expect(adivinado.complexity).toBeGreaterThan(seguro.complexity * 5);
  });
});

describe('regresion de accuracy', () => {
  const accuracy = (semantic: boolean): number => {
    const ok = EVAL_SET.filter(
      (c) => analyze(c.text, semantic ? {} : { semantic: false }).primaryIntent === c.expected,
    ).length;
    return ok / EVAL_SET.length;
  };

  it('el semantico mejora al lexico sobre el set held-out', () => {
    const conSemantico = accuracy(true);
    expect(conSemantico).toBeGreaterThan(accuracy(false));
    // Piso de regresion: si un cambio futuro baja de aca, el test avisa.
    expect(conSemantico).toBeGreaterThanOrEqual(0.7);
  });
});
