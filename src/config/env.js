import 'dotenv/config';
import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата в формате ГГГГ-ММ-ДД')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'такой даты не существует');

const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('ru-BY', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'неизвестный часовой пояс');

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error: 'допустимо development, test или production',
    }),
    PORT: z.coerce
      .number({ error: 'ожидается число' })
      .int('ожидается целое число')
      .min(1, 'порт от 1 до 65535')
      .max(65535, 'порт от 1 до 65535'),
    DATABASE_URL: z.url('нужен полный postgres:// URL'),
    TEST_DATABASE_URL: z.url('нужен полный postgres:// URL').optional(),
    SESSION_SECRET: z.string().min(32, 'минимум 32 символа'),
    SESSION_TTL_HOURS: z.coerce
      .number({ error: 'ожидается число' })
      .positive('ожидается положительное число часов'),
    APP_URL: z.url('нужен полный URL, например http://localhost:3000'),
    HTTPS: z.enum(['0', '1', 'true', 'false'], { error: 'допустимо 0 или 1' }),
    TLS_CERT_PATH: z.string().optional(),
    TLS_KEY_PATH: z.string().optional(),
    SEED_DEMO: z.enum(['0', '1', 'true', 'false'], { error: 'допустимо 0 или 1' }),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
      error: 'неизвестный уровень логирования',
    }),
    TZ: timezone,
    // An empty string is a valid "use the real current date" value; anything
    // else must be a full ISO date, otherwise analytics would silently drift.
    ANALYTICS_REFERENCE_DATE: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      isoDate.optional(),
    ),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'test' && !value.TEST_DATABASE_URL) {
      context.addIssue({
        code: 'custom',
        path: ['TEST_DATABASE_URL'],
        message: 'для NODE_ENV=test обязательно отдельное подключение к тестовой БД',
      });
    }
    if (value.HTTPS === '1' || value.HTTPS === 'true') {
      if (!value.TLS_CERT_PATH) {
        context.addIssue({
          code: 'custom',
          path: ['TLS_CERT_PATH'],
          message: 'обязателен при HTTPS=1',
        });
      }
      if (!value.TLS_KEY_PATH) {
        context.addIssue({
          code: 'custom',
          path: ['TLS_KEY_PATH'],
          message: 'обязателен при HTTPS=1',
        });
      }
    }
  });

const parsed = environmentSchema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'окружение'} — ${issue.message}`)
    .join('; ');
  throw new Error(
    `Не удалось прочитать настройки окружения: ${problems}. Сверьтесь с .env.example.`,
  );
}

const config = parsed.data;

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';

// Server processes read the timezone once, so apply it even when the default
// was used instead of a value from .env.
process.env.TZ = config.TZ;

const httpsEnabled = config.HTTPS === '1' || config.HTTPS === 'true';

/** Validated application configuration. Values are camelCased, never read raw env vars elsewhere. */
export const env = Object.freeze({
  nodeEnv: config.NODE_ENV,
  port: config.PORT,
  databaseUrl: isTest ? config.TEST_DATABASE_URL : config.DATABASE_URL,
  sessionSecret: config.SESSION_SECRET,
  sessionTtlHours: config.SESSION_TTL_HOURS,
  appUrl: config.APP_URL,
  https: httpsEnabled,
  tlsCertPath: config.TLS_CERT_PATH ?? '',
  tlsKeyPath: config.TLS_KEY_PATH ?? '',
  seedDemo: config.SEED_DEMO === '1' || config.SEED_DEMO === 'true',
  logLevel: config.LOG_LEVEL,
  timezone: config.TZ,
  analyticsReferenceDate: config.ANALYTICS_REFERENCE_DATE ?? null,
});
