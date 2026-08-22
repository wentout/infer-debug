import { matchRouteTemplate } from '../src/models/route-matcher';

describe('matchRouteTemplate', () => {
  it('matches exact paths', () => {
    expect(matchRouteTemplate('/api/orders', '/api/orders')).toBe(true);
    expect(matchRouteTemplate('/api/orders', '/api/customers')).toBe(false);
  });

  it('matches {param} as a single path segment', () => {
    expect(matchRouteTemplate('/api/orders/{id}/cancel', '/api/orders/abc-123/cancel')).toBe(true);
    expect(matchRouteTemplate('/api/orders/{id}/cancel', '/api/orders/abc-123/extra/cancel')).toBe(false);
    expect(matchRouteTemplate('/api/orders/{id}/cancel', '/api/orders/cancel')).toBe(false);
  });

  it('matches /{*} as an optional subtree', () => {
    expect(matchRouteTemplate('/api/orders/{*}', '/api/orders')).toBe(true);
    expect(matchRouteTemplate('/api/orders/{*}', '/api/orders/anything/deep')).toBe(true);
    expect(matchRouteTemplate('/api/orders/{*}', '/api/customers')).toBe(false);
  });

  it('does not treat regex metacharacters in templates as regex', () => {
    expect(matchRouteTemplate('/json/list', '/jsonXlist')).toBe(false);
    expect(matchRouteTemplate('/api/a.b', '/api/a.b')).toBe(true);
    expect(matchRouteTemplate('/api/a.b', '/api/axb')).toBe(false);
  });
});
