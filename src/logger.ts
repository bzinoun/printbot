import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
  transport:
    process.env.NODE_ENV === 'production' || process.env.VITEST
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
})
