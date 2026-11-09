import { z } from 'zod';

// .env 文件的加载由各 Node 入口（launch.ts / db/init.ts / 脚本）负责，
// 这样 Workers bundle 不会把 dotenv 及其 fs 依赖一起打进去。

/** 空串与未设置同等对待，避免 compose 传 `""` 时 zod 校验失败。 */
const textWithDefault = (def: string) =>
  z.preprocess((v) => (v === '' || v == null ? def : v), z.string());

const positiveInt = (def: number) =>
  z.preprocess(
    (v) => (v === '' || v == null ? def : v),
    z.coerce.number().int().positive(),
  );

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(16, 'JWT_SECRET 至少 16 位'),
    JWT_EXPIRES_IN: z.string().default('30d'),
    PORT: z.coerce.number().default(4000),
    CORS_ORIGINS: z.string().default('*'),
    STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('uploads'),
    // Cloudflare R2（STORAGE_DRIVER=r2 时必填前四项）
    R2_ACCOUNT_ID: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    // 公开域：绑定自定义域后可直出永久 URL；留空则走后端代理读取
    R2_PUBLIC_URL: z.string().optional(),
    // 覆盖默认 endpoint（本地 S3 mock / 其它 S3 兼容服务）
    R2_ENDPOINT: z.string().optional(),
    R2_REGION: textWithDefault('auto'),
    R2_TIMEOUT_MS: positiveInt(15_000),
    // 对外可访问的基址（如 https://api.example.com）。用于把上传后的相对路径
    // 拼成绝对 URL——小程序无法加载相对路径的图片。未配置时返回相对路径。
    PUBLIC_BASE_URL: z.string().optional(),
    // 可选：Meoo Cloud 老库连接串，仅用于 pg_dump 同步提示（不进运行时逻辑）
    MEOO_DATABASE_URL: z.string().optional(),
    // 找回密码：外部 SMTP（465 隐式 TLS / 其它端口 STARTTLS）
    RECOVERY_SMTP_HOST: z.string().optional(),
    RECOVERY_SMTP_PORT: z.coerce.number().optional(),
    RECOVERY_SMTP_USER: z.string().optional(),
    RECOVERY_SMTP_PASS: z.string().optional(),
    RECOVERY_MAIL_FROM: z.string().optional(),
    // 微信小程序登录（jscode2session 所需，可选）
    WX_APP_ID: z.string().optional(),
    WX_APP_SECRET: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.STORAGE_DRIVER !== 'r2') return;
    const required = [
      'R2_ACCOUNT_ID',
      'R2_BUCKET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ] as const;
    for (const name of required) {
      if (!val[name]?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `STORAGE_DRIVER=r2 时 ${name} 必填`,
        });
      }
    }
    if (val.R2_PUBLIC_URL && !/^https?:\/\//i.test(val.R2_PUBLIC_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['R2_PUBLIC_URL'],
        message: 'R2_PUBLIC_URL 必须是完整 http(s) URL',
      });
    }
    if (val.R2_ENDPOINT && !/^https?:\/\//i.test(val.R2_ENDPOINT)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['R2_ENDPOINT'],
        message: 'R2_ENDPOINT 必须是完整 http(s) URL',
      });
    }
  });

// Cloudflare Workers 没有 Node 进程环境：Worker 入口在动态 import 后端之前，
// 把 bindings 注入 globalThis.__DETECT_ENV__，这里合并后统一校验。
// Node 路径没有该注入，行为与改造前完全一致。
const injected = (globalThis as Record<string, unknown>).__DETECT_ENV__ as
  | Record<string, string | undefined>
  | undefined;
const source = injected ? { ...process.env, ...injected } : process.env;

const parsed = schema.safeParse(source);
if (!parsed.success) {
  console.error('[env] 环境变量校验失败：', parsed.error.flatten().fieldErrors);
  throw new Error('env validation failed');
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim());
