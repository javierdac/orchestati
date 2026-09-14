import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/analyzer.js';

describe('analyzer', () => {
  it('trata un saludo suelto como reflex y complejidad casi nula', () => {
    const s = analyze('hola');
    expect(s.primaryIntent).toBe('greeting');
    expect(s.suggestedTier).toBe('reflex');
    expect(s.complexity).toBeLessThan(0.1);
  });

  it('no deja que un saludo secuestre un pedido real', () => {
    const s = analyze('hola, necesito refactorizar este modulo de pagos que quedo hecho un desastre');
    expect(s.primaryIntent).toBe('refactor');
    expect(s.suggestedTier).not.toBe('reflex');
  });

  it('escala segun la complejidad del pedido', () => {
    const facil = analyze('que es un closure');
    const medio = analyze('escribime una funcion typescript que valide un email');
    const dificil = analyze(
      'mi app tira TypeError: cannot read property map of undefined en src/list.tsx y no entiendo por que',
    );
    expect(facil.complexity).toBeLessThan(medio.complexity);
    expect(medio.complexity).toBeLessThan(dificil.complexity);
  });

  it('detecta stack traces aunque el error venga pegado al prefijo', () => {
    expect(analyze('TypeError: x is not a function').artifacts.hasStackTrace).toBe(true);
    expect(analyze('NullPointerException in thread main').artifacts.hasStackTrace).toBe(true);
    expect(analyze('hola como va').artifacts.hasStackTrace).toBe(false);
  });

  it('marca riesgo en acciones irreversibles', () => {
    const s = analyze('borra todos los registros de la tabla users en produccion');
    expect(s.risk).toBeGreaterThanOrEqual(0.5);
    // Con riesgo alto no queremos que lo atienda el agente mas barato.
    expect(s.suggestedTier).not.toBe('reflex');
    expect(s.suggestedTier).not.toBe('light');
  });

  it('manda a swarm solo cuando el pedido es pesado Y multiple', () => {
    const multiple = analyze(
      'investiga y compara opciones de base de datos vectorial para RAG, despues armame un plan de migracion y ademas estima costos',
    );
    expect(multiple.suggestedTier).toBe('swarm');

    // Un solo pedido, por dificil que sea, no gana nada con fan-out.
    const unico = analyze(
      'explicame en profundidad como funciona el garbage collector generacional de la JVM y sus fases',
    );
    expect(unico.suggestedTier).not.toBe('swarm');
  });

  it('cuenta pedidos encadenados con y sin conector "y"', () => {
    expect(analyze('hace A, despues hace B').structure.chainedRequests).toBeGreaterThanOrEqual(1);
    expect(analyze('hace A y despues hace B ademas de C').structure.chainedRequests).toBeGreaterThanOrEqual(2);
  });

  it('es determinista', () => {
    const a = analyze('refactorizame esto');
    const b = analyze('refactorizame esto');
    expect(a.complexity).toBe(b.complexity);
    expect(a.primaryIntent).toBe(b.primaryIntent);
  });
});
