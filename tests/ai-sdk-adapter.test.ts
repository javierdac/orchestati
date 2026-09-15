import { describe, expect, it } from 'vitest';
import { generateText, streamText } from 'ai';
import { orchestatiModel, convertPrompt } from '../src/llm/ai-sdk-adapter.js';
import { Orchestrator } from '../src/runtime/orchestrator.js';
import { MockModel } from '../src/llm/model.js';
import { allowAll } from '../src/tools/confirm.js';
import { z } from 'zod';
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';

const nuevo = () => new Orchestrator({ model: new MockModel(), confirm: allowAll(), root: process.cwd() });

describe('convertPrompt', () => {
  it('toma el ultimo mensaje del usuario como el pedido a rutear', () => {
    const prompt: LanguageModelV4Prompt = [
      { role: 'user', content: [{ type: 'text', text: 'hola' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'buenas' }] },
      { role: 'user', content: [{ type: 'text', text: 'que es un closure' }] },
    ];
    const { input, history } = convertPrompt(prompt);

    expect(input).toBe('que es un closure');
    expect(history).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'buenas' },
    ]);
  });

  it('junta varias partes de texto del mismo mensaje', () => {
    const { input } = convertPrompt([
      { role: 'user', content: [{ type: 'text', text: 'primero' }, { type: 'text', text: 'segundo' }] },
    ]);
    expect(input).toBe('primero\nsegundo');
  });

  it('conserva el mensaje de sistema del llamador como contexto', () => {
    const { history } = convertPrompt([
      { role: 'system', content: 'sos formal' } as never,
      { role: 'user', content: [{ type: 'text', text: 'hola' }] },
    ]);
    expect(history[0]).toEqual({ role: 'system', content: 'sos formal' });
  });

  it('no rompe con un prompt sin mensajes de usuario', () => {
    const { input, history } = convertPrompt([{ role: 'system', content: 'x' } as never]);
    expect(input).toBe('x');
    expect(history).toEqual([]);
  });
});

describe('generateText contra el orquestador', () => {
  it('devuelve texto como cualquier modelo', async () => {
    const res = await generateText({ model: orchestatiModel(nuevo()), prompt: 'hola' });
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('expone la decision de ruteo en providerMetadata', async () => {
    const res = await generateText({ model: orchestatiModel(nuevo()), prompt: 'hola' });
    const meta = res.providerMetadata?.orchestati as Record<string, unknown> | undefined;

    expect(meta?.tier).toBe('reflex');
    expect(meta?.agents).toEqual(['reflex.smalltalk']);
    expect(meta?.intent).toBe('greeting');
    expect(meta?.runId).toBeTruthy();
  });

  it('un saludo no consume tokens; un pedido real si', async () => {
    const saludo = await generateText({ model: orchestatiModel(nuevo()), prompt: 'hola' });
    const pedido = await generateText({
      model: orchestatiModel(nuevo()),
      prompt: 'escribime una funcion que valide un email en typescript',
    });

    expect(saludo.usage.outputTokens).toBe(0);
    expect(pedido.usage.outputTokens ?? 0).toBeGreaterThan(0);
  });

  it('el ruteo cambia con el pedido, no con la configuracion', async () => {
    const model = orchestatiModel(nuevo());
    const facil = await generateText({ model, prompt: 'hola' });
    const dificil = await generateText({
      model,
      prompt: 'disename la arquitectura completa de un sistema de facturacion multi-tenant con auditoria',
    });

    const t1 = (facil.providerMetadata?.orchestati as Record<string, unknown>)?.tier;
    const t2 = (dificil.providerMetadata?.orchestati as Record<string, unknown>)?.tier;
    expect(t1).toBe('reflex');
    expect(t2).toBe('deep');
  });

  it('avisa que las herramientas del llamador no se usan, en vez de ignorarlas calladamente', async () => {
    const res = await generateText({
      model: orchestatiModel(nuevo()),
      prompt: 'hola',
      tools: {
        clima: { description: 'da el clima', inputSchema: z.object({ ciudad: z.string() }) },
      } as never,
    });
    expect(res.warnings?.some((w) => w.type === 'unsupported' && w.feature === 'tools')).toBe(true);
  });

  it('respeta la conversacion multi-turno', async () => {
    const res = await generateText({
      model: orchestatiModel(nuevo()),
      messages: [
        { role: 'user', content: 'escribime un parser de csv' },
        { role: 'assistant', content: 'ahi va' },
        { role: 'user', content: 'gracias!' },
      ],
    });
    // Se rutea el ultimo pedido, no toda la conversacion junta.
    expect((res.providerMetadata?.orchestati as Record<string, unknown>)?.tier).toBe('reflex');
  });
});

describe('streamText contra el orquestador', () => {
  it('entrega el texto en fragmentos', async () => {
    const res = streamText({
      model: orchestatiModel(nuevo()),
      prompt: 'escribime una funcion que valide un email',
    });

    const trozos: string[] = [];
    for await (const t of res.textStream) trozos.push(t);

    expect(trozos.length).toBeGreaterThan(1);
    expect(trozos.join('')).toBe(await res.text);
  });

  it('un reflex tambien llega como texto, aunque no haya streaming real detras', async () => {
    const res = streamText({ model: orchestatiModel(nuevo()), prompt: 'hola' });
    expect((await res.text).length).toBeGreaterThan(0);
    expect((await res.usage).outputTokens).toBe(0);
  });

  it('cierra con uso y metadata de ruteo', async () => {
    const res = streamText({ model: orchestatiModel(nuevo()), prompt: 'cuanto es (2340 * 15) / 100' });
    await res.consumeStream();

    const meta = (await res.providerMetadata)?.orchestati as Record<string, unknown> | undefined;
    expect(meta?.agents).toContain('llm.analyst');
    expect((meta?.toolCalls as unknown[])?.length).toBeGreaterThan(0);
    expect((await res.usage).inputTokens ?? 0).toBeGreaterThan(0);
  });

  it('en paralelo no entremezcla el texto de varios agentes', async () => {
    const res = streamText({
      model: orchestatiModel(nuevo()),
      prompt:
        'investiga y compara opciones de base de datos vectorial, despues un plan y ademas estima costos',
    });
    await res.consumeStream();

    const meta = (await res.providerMetadata)?.orchestati as Record<string, unknown> | undefined;
    expect(meta?.strategy).toBe('parallel');
    // El texto final es el del sintetizador, no la suma de los tres.
    expect(await res.text).not.toContain('---');
  });
});
