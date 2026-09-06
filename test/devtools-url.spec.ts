import { buildDevtoolsJumpUrl } from '../src/models/devtools-url';

describe('buildDevtoolsJumpUrl', () => {
  it('points ws at the given host and inspector target', () => {
    expect(buildDevtoolsJumpUrl('api.example.com', 'abc-123')).toBe(
      'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=api.example.com/abc-123',
    );
  });
});
