import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  const req = { method: 'GET', url: '/x', id: 'req-12345678' };
  const host = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status: res.status.mock.calls[0][0] as number, body: json.mock.calls[0][0] as Record<string, unknown> };
}

describe('AllExceptionsFilter', () => {
  it('never leaks internal error text, stacks or SQL for unexpected errors', () => {
    const { status, body } = run(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    expect(status).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5|stack|at .*\(/);
    expect(body.requestId).toBe('req-12345678');
  });
  it('passes through deliberate client errors with their message', () => {
    expect(run(new BadRequestException('Choose a valid category'))).toMatchObject({ status: 400, body: { message: 'Choose a valid category' } });
  });
  it('treats body-parser style errors as client errors, not 500s', () => {
    const tooBig = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' });
    expect(run(tooBig)).toMatchObject({ status: 413, body: { message: 'Request body too large' } });
    const badJson = Object.assign(new SyntaxError('Unexpected token } in JSON'), { status: 400, type: 'entity.parse.failed' });
    const r = run(badJson);
    expect(r).toMatchObject({ status: 400, body: { message: 'Malformed JSON' } });
    expect(JSON.stringify(r.body)).not.toContain('Unexpected token');
  });
});
