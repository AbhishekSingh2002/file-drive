import { ConvexError, v } from "convex/values";
import {
  MutationCtx,
  QueryCtx,
  internalMutation,
  query,
} from "./_generated/server";
import { roles } from "./schema";

// Remove the import from files.ts to break the circular dependency
// import { hasAccessToOrg } from "./files";  

// Create a simpler version of hasAccessToOrg directly in this file
async function hasUserAccessToOrg(
  ctx: QueryCtx | MutationCtx,
  user: any,
  orgId: string
) {
  if (!user.orgIds) {
    return false;
  }
  
  return user.orgIds.some((org: any) => org.orgId === orgId);
}

export async function getUser(
  ctx: QueryCtx | MutationCtx,
  tokenIdentifier: string
) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", tokenIdentifier)
    )
    .first();

  if (!user) {
    throw new ConvexError("expected user to be defined");
  }

  return user;
}

export const createUser = internalMutation({
  args: { tokenIdentifier: v.string(), name: v.string(), image: v.string() },
  async handler(ctx, args) {
    await ctx.db.insert("users", {
      tokenIdentifier: args.tokenIdentifier,
      orgIds: [], // Initialize with empty array
      name: args.name,
      image: args.image,
    });
  },
});

export const updateUser = internalMutation({
  args: { tokenIdentifier: v.string(), name: v.string(), image: v.string() },
  async handler(ctx, args) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", args.tokenIdentifier)
      )
      .first();

    if (!user) {
      throw new ConvexError("no user with this token found");
    }

    await ctx.db.patch(user._id, {
      name: args.name,
      image: args.image,
    });
  },
});

export const addOrgIdToUser = internalMutation({
  args: { tokenIdentifier: v.string(), orgId: v.string(), role: roles },
  async handler(ctx, args) {
    const user = await getUser(ctx, args.tokenIdentifier);

    // Ensure orgIds exists
    const orgIds = user.orgIds || [];
    
    // Check if this org is already in the user's list
    const existingOrg = orgIds.find((org: any) => org.orgId === args.orgId);
    if (existingOrg) {
      console.log("Organization already exists for user, updating role");
      existingOrg.role = args.role;
    } else {
      // Add new org to the list
      orgIds.push({ orgId: args.orgId, role: args.role });
    }

    await ctx.db.patch(user._id, { orgIds });
  },
});

export const updateRoleInOrgForUser = internalMutation({
  args: { tokenIdentifier: v.string(), orgId: v.string(), role: roles },
  async handler(ctx, args) {
    const user = await getUser(ctx, args.tokenIdentifier);

    // Ensure orgIds exists
    if (!user.orgIds) {
      user.orgIds = [];
    }

    const org = user.orgIds.find((org) => org.orgId === args.orgId);

    if (!org) {
      // Add org if it doesn't exist
      user.orgIds.push({ orgId: args.orgId, role: args.role });
    } else {
      // Update role if org exists
      org.role = args.role;
    }

    await ctx.db.patch(user._id, {
      orgIds: user.orgIds,
    });
  },
});

export const getUserProfile = query({
  args: { userId: v.id("users") },
  async handler(ctx, args) {
    const user = await ctx.db.get(args.userId);

    return {
      name: user?.name,
      image: user?.image,
    };
  },
});

export const getMe = query({
  args: {},
  async handler(ctx) {
    const identity = await ctx.auth.getUserIdentity();

    if (!identity) {
      return null;
    }

    const user = await getUser(ctx, identity.tokenIdentifier);

    if (!user) {
      return null;
    }

    return user;
  },
});