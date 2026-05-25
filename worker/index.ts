import { Hono, type Context } from 'hono'
import { UserDO } from './user-do'

export { UserDO }

interface Env {
  USER: DurableObjectNamespace
}

const app = new Hono<{ Bindings: Env }>()

// Any sub-path under /:user → proxy to UserDO; bare /:user falls through to assets (SPA)
app.all('/:user{[a-z0-9]+}/*', proxyToUserDO)

async function proxyToUserDO(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { user } = c.req.param()
  const stub = c.env.USER.get(c.env.USER.idFromName(user))
  const url = new URL(c.req.url)
  url.pathname = url.pathname.slice(`/${user}`.length) || '/'
  return stub.fetch(new Request(url.toString(), c.req.raw))
}

export default app
