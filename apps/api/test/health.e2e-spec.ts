import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'http';
import request from 'supertest';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { HealthModule } from '../src/modules/health/health.module.js';

// F01 e2e: het health-endpoint reëel raken via de Nest test-adapter + supertest,
// precies zoals de opdracht voorschrijft. De response wordt getoetst tegen het
// gedeelde contract uit `@vve/contract` (ziet `healthResponse`, zie controller).
describe('Health-endpoint (F01 e2e)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let http: Server;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health levert HTTP 200 met {"status":"ok"} terug', async () => {
    const res = await request(http).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
