// Device notifications (Web Push). The server sends them; this registers the device.
import { supabase } from '@/lib/supabase'
import { toError } from '@/api/errors'

const KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

/** The server's public key is configured for this build. */
export const pushConfigured = !!KEY

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(new ArrayBuffer(b.length))
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('The app’s offline worker isn’t running — reload and try again.')), 8000))
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${br}`
}

/** This device's subscription, if it has one. */
export async function currentPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  return (await registration()).pushManager.getSubscription()
}

/** Ask permission, subscribe this device, and remember it on the server. */
export async function enablePush(): Promise<void> {
  if (!KEY) throw new Error('Notifications aren’t set up on the server yet.')
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Notifications weren’t allowed.')
  const reg = await registration()
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(KEY) }))
  const j = sub.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert(
    { endpoint: sub.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, device: deviceLabel() }, { onConflict: 'endpoint' })
  if (error) throw toError(error)
}

export async function disablePush(): Promise<void> {
  const sub = await currentPush()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}

/** Ask the server to push a test notification to this account's devices; returns how many got it. */
export async function sendTestPush(): Promise<number> {
  const { data, error } = await supabase.functions.invoke('push-test', { body: {} })
  if (error) throw new Error(error.message)
  return Number((data as { sent?: number } | null)?.sent ?? 0)
}
