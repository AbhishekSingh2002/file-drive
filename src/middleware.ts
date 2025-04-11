// src/middleware.ts
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  // Adjust this matcher as per your app's protected routes
  matcher: [
    "/((?!api|_next|favicon.ico|logo.png).*)",
  ],
};
