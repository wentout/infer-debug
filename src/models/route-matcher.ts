/**
 * Matches a swagger-style route template against an actual request path.
 *
 * Supported syntax:
 * - `{param}` — matches a single path segment (`[^/]+`)
 * - `/{*}` suffix — matches the rest of the path, including empty (subtree wildcard)
 *
 * Examples:
 *   `/api/orders/{id}/cancel` matches `/api/orders/abc/cancel`
 *   `/api/orders/{*}`         matches `/api/orders` and `/api/orders/anything/deep`
 */
export function matchRouteTemplate(template: string, actual: string): boolean {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withSubtreeWildcard = escaped.replace(/\/\\\{\\\*\\\}/g, '(?:/.*)?');
  const parameterized = withSubtreeWildcard.replace(/\\\{[^}]+\\\}/g, '[^/]+');
  const regex = new RegExp('^' + parameterized + '$');
  return regex.test(actual);
}
