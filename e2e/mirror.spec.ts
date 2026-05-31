import { test, expect } from '@playwright/test'

// Happy path: a user registers a passkey on one "device" (tab), opens a second
// device that auto-authenticates via the shared session cookie, then mirrors its
// camera to the second device over WebRTC.
test('register a passkey and mirror camera to a second device', async ({ page, context }) => {
  // Fresh user per run so the persisted Durable Object never reports "already
  // registered". Lowercase letters + digits only, to match the worker's /:user route.
  const user = `e2e${Date.now()}`

  // Attach a CDP virtual authenticator to the first tab so startRegistration()
  // resolves without a real OS/passkey prompt.
  const client = await context.newCDPSession(page)
  await client.send('WebAuthn.enable')
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await context.grantPermissions(['camera'])

  // Device 1 — register the passkey.
  await page.goto(`/${user}`)
  await page.getByRole('button', { name: `Register as ${user}` }).click()
  // Reaching the idle streaming panel ('share camera' visible) means state === 'connected'.
  await expect(page.getByRole('button', { name: 'share camera' })).toBeVisible({ timeout: 30_000 })

  // Device 2 — same context, so it inherits the __session cookie and connects
  // straight to the streaming panel (its own deviceId comes from sessionStorage).
  const page2 = await context.newPage()
  await page2.goto(`/${user}`)
  await expect(page2.getByRole('button', { name: 'share camera' })).toBeVisible({ timeout: 30_000 })

  // Device 1 starts mirroring its (fake) camera.
  await page.getByRole('button', { name: 'share camera' }).click()

  // Device 1 should count device 2 as a viewer.
  await expect(page.locator('.stream-status')).toContainText('1 device', { timeout: 30_000 })

  // Device 2 should actually receive decoded video frames.
  await expect(page2.locator('video.remote-video')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      () =>
        page2
          .locator('video.remote-video')
          .evaluate((v: HTMLVideoElement) => v.videoWidth),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0)
})
