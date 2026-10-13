// ============================================================
// E2E REAL A BD — solo lo mínimo y crítico (fetch directo, sin deps):
//   · API alcanzable y tablas existen (respuestas estructuradas)
//   · login real con usuario de prueba (env vars opcionales)
//   · consulta autenticada a territorios_asignaciones (grants + RLS)
//   · RPCs críticos desplegados (error de negocio, no "función inexistente")
// Los tests que requieren credenciales se saltan sin env vars:
//   SUPABASE_TEST_EMAIL / SUPABASE_TEST_PASSWORD
// ============================================================
import { expect, it, describe } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://yfdkyccmaseztypccoww.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_jmltUeff0VTuLXf2KrujcA_zktLmoSS';
const EMAIL = process.env.SUPABASE_TEST_EMAIL ?? '';
const PASS = process.env.SUPABASE_TEST_PASSWORD ?? '';
const BASE = { apikey: ANON_KEY };

describe('E2E real · API y esquema (sin credenciales)', () => {
  it('la API REST responde y la tabla puntos existe (RLS/grants estructurados)', async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/puntos?select=id&limit=1`, { headers: { ...BASE } });
    // Con anon sin grant: 401/403 con { code: '42501', message: 'permission denied...' }
    // → prueba que la API está viva y la tabla existe.
    expect([200, 401, 403]).toContain(r.status);
    const body = await r.json().catch(() => null);
    expect(body).not.toBeNull();
    expect(String(body?.message ?? '')).not.toMatch(/does not exist/i);
  });

  it('la tabla territorios_asignaciones existe (misma verificación)', async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/territorios_asignaciones?select=territorio_id&limit=1`, { headers: { ...BASE } });
    expect([200, 401, 403]).toContain(r.status);
    const body = await r.json().catch(() => null);
    expect(body).not.toBeNull();
    expect(String(body?.message ?? '')).not.toMatch(/does not exist/i);
  });

  it('el servicio de auth responde', async () => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { ...BASE } });
    expect(r.status).toBe(200);
  });
});

(EMAIL && PASS ? describe : describe.skip)('E2E real · autenticado (requiere env de prueba)', () => {
  let token = null;

  it('login real con usuario de prueba', async () => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { ...BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    token = body.access_token;
    expect(token).toBeTruthy();
  });

  it('territorios_asignaciones consultable autenticado (grants + RLS)', async () => {
    expect(token).toBeTruthy();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/territorios_asignaciones?select=territorio_id,estado&limit=1`, {
      headers: { ...BASE, Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });

  it('RPCs críticos desplegados (error de negocio, no PGRST202)', async () => {
    expect(token).toBeTruthy();
    const fake = '00000000-0000-0000-0000-000000000000';

    const r1 = await fetch(`${SUPABASE_URL}/rest/v1/rpc/marcar_estado`, {
      method: 'POST',
      headers: { ...BASE, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: fake, p_estado: 'visitado' }),
    });
    const b1 = await r1.json().catch(() => ({}));
    expect(b1?.code).not.toBe('PGRST202'); // marcar_estado existe y responde

    const r2 = await fetch(`${SUPABASE_URL}/rest/v1/rpc/devolver_territorio`, {
      method: 'POST',
      headers: { ...BASE, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const b2 = await r2.json().catch(() => ({}));
    expect(b2?.code).not.toBe('PGRST202'); // devolver_territorio existe y responde
  });

  it('logout revoca la sesión de prueba', async () => {
    expect(token).toBeTruthy();
    const r = await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=global`, {
      method: 'POST',
      headers: { ...BASE, Authorization: `Bearer ${token}` },
    });
    expect([200, 204]).toContain(r.status);
  });
});
