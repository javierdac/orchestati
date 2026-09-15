import { lookup } from 'node:dns/promises';

/**
 * Defensa contra SSRF.
 *
 * Filtrar por el texto del hostname no alcanza por dos motivos: un dominio
 * publico puede resolver a una IP privada (DNS rebinding), y una respuesta
 * puede redirigir a una. Por eso se resuelve el nombre y se valida la IP, en
 * cada salto de la cadena de redirecciones.
 */

/** Rangos que nunca deberian ser alcanzables desde una herramienta del modelo. */
export function isPrivateAddress(ip: string): boolean {
  const limpio = ip.replace(/^\[|\]$/g, '').toLowerCase();

  // IPv4 mapeada en IPv6: ::ffff:127.0.0.1
  const mapeada = limpio.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapeada) return isPrivateAddress(mapeada[1]!);

  if (limpio.includes(':')) {
    if (limpio === '::' || limpio === '::1') return true;
    // fc00::/7 (unique local) y fe80::/10 (link local)
    if (/^f[cd][0-9a-f]{2}:/.test(limpio)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(limpio)) return true;
    return false;
  }

  const partes = limpio.split('.').map(Number);
  if (partes.length !== 4 || partes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Si no se puede interpretar, se rechaza: fallar cerrado.
    return true;
  }
  const [a, b] = partes as [number, number, number, number];

  if (a === 0) return true;                       // 0.0.0.0/8
  if (a === 10) return true;                      // privada
  if (a === 127) return true;                     // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;        // link local, incluye metadata de cloud
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;          // 192.0.0/24 y 192.0.2/24
  if (a >= 224) return true;                      // multicast y reservada
  return false;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  address?: string;
}

/** Valida esquema y, resolviendo el nombre, que la IP no sea privada. */
export async function checkUrlIsPublic(raw: string | URL): Promise<UrlCheck> {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return { ok: false, reason: 'URL invalida' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'solo se permiten http(s)' };
  }

  // Una IP literal se valida directo, sin consultar DNS.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    return isPrivateAddress(hostname)
      ? { ok: false, reason: 'no se permiten destinos de red local', address: hostname }
      : { ok: true, address: hostname };
  }

  try {
    // `all` para que un nombre con varias A no pase por tener una publica.
    const registros = await lookup(hostname, { all: true });
    const privada = registros.find((r) => isPrivateAddress(r.address));
    if (privada) {
      return { ok: false, reason: `${hostname} resuelve a una direccion privada`, address: privada.address };
    }
    return { ok: true, address: registros[0]?.address ?? '' };
  } catch {
    return { ok: false, reason: `no se pudo resolver ${hostname}` };
  }
}
