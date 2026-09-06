# Route-table debugging (NestJS recipe)

`infer-debug` itself is route-agnostic: **any request carrying the trigger
header** (default: `infer-debug`) is proxied to the debug child, and the
response carries the same header with a Chrome DevTools deep link that jumps
straight to the child's inspector.

Choosing *which* of your app's routes deserve that is your app's own concern —
it is Nest-only wiring, so it lives here as an example rather than inside the
package. Three equally valid ways to mark requests:

1. **Client-side** — just send the header when you want the child:

   ```bash
   curl -H 'infer-debug: 1' https://api.example.com/api/orders/42
   ```

2. **Edge-side** — let your gateway/ingress set the header for chosen
   locations (nginx `proxy_set_header infer-debug 1;` inside a `location`
   block, etc.). No app code at all.

3. **App-side route table** — [`route-debug.middleware.ts`](./route-debug.middleware.ts):
   a tiny NestJS middleware that owns a swagger-template route table
   (`/api/orders/{id}`, `/api/orders/{*}`) and sets the header on matches.
   Register it in the **root module's** `configure()` — NestJS runs the root
   module's middleware before the imported `InferDebugModule`'s, so the header
   is already set when infer-debug looks at the request:

   ```typescript
   export class AppModule implements NestModule {
     configure(consumer: MiddlewareConsumer): void {
       consumer.apply(RouteDebugMiddleware).forRoutes('*');
     }
   }
   ```

Whichever way you pick, the answer header tells you where the debuggable
process is:

```
infer-debug: devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=api.example.com/8f3c…
```

Paste it into Chrome and you are attached to the child — through the app's
own port, no extra tunnels.
