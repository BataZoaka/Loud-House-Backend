import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without a JWT.
 *
 * The guard is registered globally in AppModule, so the default for every
 * endpoint is "authentication required" and you opt OUT with @Public(). That
 * ordering matters: if the default were "open" and you opted in with a guard,
 * then forgetting the decorator on a new endpoint silently exposes it. This
 * way, forgetting it just means the endpoint 401s and you notice immediately.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
