/** Hoofdmodule — bundelt de databaseverbinding en de functionele modules. */
import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { VveModule } from './modules/vve/vve.module.js';

@Module({ imports: [DatabaseModule, HealthModule, AuthModule, VveModule] })
export class AppModule {}
