import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@/common/decorators/current-user.decorator';

/**
 * Gate for operator-only routes (creating raffles, running draws, adjusting
 * balances). Stack it after JwtAuthGuard: @UseGuards(JwtAuthGuard, AdminGuard).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!user?.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
