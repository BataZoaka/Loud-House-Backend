import { ExecutionContext, createParamDecorator } from '@nestjs/common';

export interface AuthenticatedUser {
  id: string;
  walletAddress: string;
  isAdmin: boolean;
}

/**
 * Injects the user the JWT strategy resolved: `@CurrentUser() user`.
 *
 * Always take the acting user from the token, never from the request body.
 * An endpoint that accepts `{ userId }` from the client and trusts it lets
 * anyone act as anyone.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
