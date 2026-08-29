// routes.js — API 路由表，把 HTTP 请求映射到各业务模块
import { adminConfig, publicConfigStatus, updateAdminConfig } from './config.js';
import { createAddress, listMails, deleteMail } from './cloudflareEmail.js';
import {
  getBalance,
  fetchAvailableCountries,
  fetchPriceQuotes,
  requestNumber,
  getStatus,
  finishNumber,
  cancelNumber,
  requestAnotherSms,
} from './heroSms.js';
import {
  startAutomation,
  automationStatus,
  continueAutomation,
  restartAutomation,
  cancelAutomation,
  openAutomationProfile,
} from './automation.js';
import {
  cancelCodexDeviceAuth,
  codexDeviceAuthStatus,
  probeCodexAccount,
  startCodexDeviceAuth,
} from './codexDeviceAuth.js';

// 每个 handler 返回可被 JSON 序列化的对象；抛错由 server 统一捕获
export const routes = [
  {
    method: 'GET',
    path: '/api/config',
    handler: async () => publicConfigStatus(),
  },
  {
    method: 'GET',
    path: '/api/admin/config',
    handler: async () => adminConfig(),
  },
  {
    method: 'POST',
    path: '/api/admin/config',
    handler: async ({ body }) => updateAdminConfig(body),
  },
  {
    method: 'POST',
    path: '/api/email/create',
    handler: async ({ body }) => createAddress({ name: body?.name }),
  },
  {
    method: 'GET',
    path: '/api/email/mails',
    handler: async ({ query }) =>
      listMails({ address: query.address, limit: query.limit, offset: query.offset }),
  },
  {
    method: 'POST',
    path: '/api/email/delete',
    handler: async ({ body }) => deleteMail(body?.id),
  },
  {
    method: 'POST',
    path: '/api/automation/start',
    handler: async ({ body }) => startAutomation(body),
  },
  {
    method: 'GET',
    path: '/api/automation/status',
    handler: async ({ query }) => automationStatus(query.id),
  },
  {
    method: 'POST',
    path: '/api/automation/continue',
    handler: async ({ body }) => continueAutomation(body),
  },
  {
    method: 'POST',
    path: '/api/automation/restart',
    handler: async ({ body }) => restartAutomation(body),
  },
  {
    method: 'POST',
    path: '/api/automation/cancel',
    handler: async ({ body }) => cancelAutomation(body),
  },
  {
    method: 'POST',
    path: '/api/automation/open-profile',
    handler: async ({ body }) => openAutomationProfile(body),
  },
  {
    method: 'GET',
    path: '/api/sms/balance',
    handler: async () => getBalance(),
  },
  {
    method: 'POST',
    path: '/api/codex/device/start',
    handler: async ({ body }) => startCodexDeviceAuth(body),
  },
  {
    method: 'GET',
    path: '/api/codex/device/status',
    handler: async ({ query }) => codexDeviceAuthStatus(query.id),
  },
  {
    method: 'POST',
    path: '/api/codex/device/cancel',
    handler: async ({ body }) => cancelCodexDeviceAuth(body),
  },
  {
    method: 'GET',
    path: '/api/codex/device/health',
    handler: async ({ query }) => probeCodexAccount({ address: query.address }),
  },
  {
    method: 'GET',
    path: '/api/sms/countries',
    handler: async ({ query }) => fetchAvailableCountries({ service: query.service }),
  },
  {
    method: 'GET',
    path: '/api/sms/prices',
    handler: async ({ query }) => fetchPriceQuotes({ service: query.service, country: query.country }),
  },
  {
    method: 'POST',
    path: '/api/sms/number',
    handler: async ({ body }) => requestNumber({ price: body?.price }),
  },
  {
    method: 'GET',
    path: '/api/sms/status',
    handler: async ({ query }) => getStatus(query.id),
  },
  {
    method: 'POST',
    path: '/api/sms/finish',
    handler: async ({ body }) => finishNumber(body?.id),
  },
  {
    method: 'POST',
    path: '/api/sms/cancel',
    handler: async ({ body }) => cancelNumber(body?.id),
  },
  {
    method: 'POST',
    path: '/api/sms/another',
    handler: async ({ body }) => requestAnotherSms(body?.id),
  },
];
