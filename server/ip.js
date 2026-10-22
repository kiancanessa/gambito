// IP del cliente para los límites de uso. Detrás de un proxy, `X-Forwarded-For` es «cliente, proxy1, proxy2…»: cada proxy añade
// al FINAL la dirección de quien le habló, así que solo las entradas del final son de fiar; la primera la escribe el propio cliente
// y, si se usara, cualquiera esquivaría todos los límites cambiando la cabecera. `TRUSTED_PROXY_HOPS` es cuántos proxys de confianza
// hay delante del servidor (1 por defecto: Render, Fly, Railway...).
import { TRUST_PROXY } from './config.js';

export function clientIp(req, { trust = TRUST_PROXY } = {}) {
  const remote = req.socket?.remoteAddress || 'unknown';
  if (!trust) return remote;
  const hops = Math.max(1, Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10) || 1);
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-64);
  if (!chain.length) return remote;
  return chain[Math.max(0, chain.length - hops)].slice(0, 64);
}
