import { ConvexError, v } from "convex/values";
import {
  MutationCtx,
  QueryCtx,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { getUser } from "./users";
import { fileTypes } from "./schema";
import { Doc, Id } from "./_generated/dataModel";

export const generateUploadUrl = mutation(async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    throw new ConvexError("you must be logged in to upload a file");
  }

  return await ctx.storage.generateUploadUrl();
});

export async function hasAccessToOrg(
  ctx: QueryCtx | MutationCtx,
  orgId: string
) {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    return null;
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_tokenIdentifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier)
    )
    .first();

  if (!user) {
    return null;
  }

  // Check if this is a personal org based on identity subject
  if (identity.subject === orgId) {
    return { user };
  }

  // Check if tokenIdentifier contains orgId (another way to check for personal org)
  if (identity.tokenIdentifier && identity.tokenIdentifier.includes(orgId)) {
    return { user };
  }

  // If orgIds is undefined or null, the user has no org access
  if (!user.orgIds) {
    return null;
  }

  // Check if user has this org in their orgIds array
  const orgAccess = user.orgIds.find((org) => org.orgId === orgId);
  if (orgAccess) {
    return { user };
  }

  return null;
}

export const createFile = mutation({
  args: {
    name: v.string(),
    fileId: v.id("_storage"),
    orgId: v.string(),
    type: fileTypes,
  },
  async handler(ctx, args) {
    const identity = await ctx.auth.getUserIdentity();
    
    if (!identity) {
      throw new ConvexError("you must be logged in to create a file");
    }
    
    // Try to get user directly first for debugging
    const user = await ctx.db
      .query("users")
      .withIndex("by_tokenIdentifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier)
      )
      .first();
      
    if (!user) {
      console.error("User not found in database");
      throw new ConvexError("user not found");
    }
    
    // Check if user has orgIds at all
    if (!user.orgIds) {
      console.error("User has no orgIds array");
      user.orgIds = []; // Initialize if missing
    }
    
    console.log("User orgIds:", user.orgIds);
    console.log("Requested orgId:", args.orgId);
    
    // Handle special case for personal orgs
    const isPersonalOrg = 
      identity.subject === args.orgId || 
      identity.tokenIdentifier.includes(args.orgId);
      
    if (isPersonalOrg) {
      console.log("Creating file in personal org");
      await ctx.db.insert("files", {
        name: args.name,
        orgId: args.orgId,
        fileId: args.fileId,
        type: args.type,
        userId: user._id,
        shouldDelete: false,
      });
      return;
    }
    
    // Check if user belongs to the org
    const hasOrg = user.orgIds.some(org => org.orgId === args.orgId);
    
    if (!hasOrg) {
      console.error("User does not have access to org:", args.orgId);
      throw new ConvexError("you do not have access to this org");
    }
    
    await ctx.db.insert("files", {
      name: args.name,
      orgId: args.orgId,
      fileId: args.fileId,
      type: args.type,
      userId: user._id,
      shouldDelete: false,
    });
  },
});

export const getFiles = query({
  args: {
    orgId: v.string(),
    query: v.optional(v.string()),
    favorites: v.optional(v.boolean()),
    deletedOnly: v.optional(v.boolean()),
    type: v.optional(fileTypes),
  },
  async handler(ctx, args) {
    const hasAccess = await hasAccessToOrg(ctx, args.orgId);

    if (!hasAccess) {
      return [];
    }

    let files = await ctx.db
      .query("files")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .collect();

    const query = args.query;

    if (query) {
      files = files.filter((file) =>
        file.name.toLowerCase().includes(query.toLowerCase())
      );
    }

    if (args.favorites) {
      const favorites = await ctx.db
        .query("favorites")
        .withIndex("by_userId_orgId_fileId", (q) =>
          q.eq("userId", hasAccess.user._id).eq("orgId", args.orgId)
        )
        .collect();

      files = files.filter((file) =>
        favorites.some((favorite) => favorite.fileId === file._id)
      );
    }

    if (args.deletedOnly) {
      files = files.filter((file) => file.shouldDelete);
    } else {
      files = files.filter((file) => !file.shouldDelete);
    }

    if (args.type) {
      files = files.filter((file) => file.type === args.type);
    }

    const filesWithUrl = await Promise.all(
      files.map(async (file) => ({
        ...file,
        url: await ctx.storage.getUrl(file.fileId),
      }))
    );

    return filesWithUrl;
  },
});

export const deleteAllFiles = internalMutation({
  args: {},
  async handler(ctx) {
    const files = await ctx.db
      .query("files")
      .withIndex("by_shouldDelete", (q) => q.eq("shouldDelete", true))
      .collect();

    await Promise.all(
      files.map(async (file) => {
        await ctx.storage.delete(file.fileId);
        return await ctx.db.delete(file._id);
      })
    );
  },
});

function assertCanDeleteFile(user: Doc<"users">, file: Doc<"files">) {
  // Handle case when orgIds is undefined
  if (!user.orgIds) {
    if (file.userId === user._id) return; // User can delete their own files
    throw new ConvexError("you have no access to delete this file");
  }
  
  const canDelete =
    file.userId === user._id ||
    user.orgIds.find((org) => org.orgId === file.orgId)?.role === "admin";

  if (!canDelete) {
    throw new ConvexError("you have no access to delete this file");
  }
}

export const deleteFile = mutation({
  args: { fileId: v.id("files") },
  async handler(ctx, args) {
    const access = await hasAccessToFile(ctx, args.fileId);

    if (!access) {
      throw new ConvexError("no access to file");
    }

    assertCanDeleteFile(access.user, access.file);

    await ctx.db.patch(args.fileId, {
      shouldDelete: true,
    });
  },
});

export const restoreFile = mutation({
  args: { fileId: v.id("files") },
  async handler(ctx, args) {
    const access = await hasAccessToFile(ctx, args.fileId);

    if (!access) {
      throw new ConvexError("no access to file");
    }

    assertCanDeleteFile(access.user, access.file);

    await ctx.db.patch(args.fileId, {
      shouldDelete: false,
    });
  },
});

export const toggleFavorite = mutation({
  args: { fileId: v.id("files") },
  async handler(ctx, args) {
    const access = await hasAccessToFile(ctx, args.fileId);

    if (!access) {
      throw new ConvexError("no access to file");
    }

    const favorite = await ctx.db
      .query("favorites")
      .withIndex("by_userId_orgId_fileId", (q) =>
        q
          .eq("userId", access.user._id)
          .eq("orgId", access.file.orgId)
          .eq("fileId", access.file._id)
      )
      .first();

    if (!favorite) {
      await ctx.db.insert("favorites", {
        fileId: access.file._id,
        userId: access.user._id,
        orgId: access.file.orgId,
      });
    } else {
      await ctx.db.delete(favorite._id);
    }
  },
});

export const getAllFavorites = query({
  args: { orgId: v.string() },
  async handler(ctx, args) {
    const hasAccess = await hasAccessToOrg(ctx, args.orgId);

    if (!hasAccess) {
      return [];
    }

    const favorites = await ctx.db
      .query("favorites")
      .withIndex("by_userId_orgId_fileId", (q) =>
        q.eq("userId", hasAccess.user._id).eq("orgId", args.orgId)
      )
      .collect();

    return favorites;
  },
});

async function hasAccessToFile(
  ctx: QueryCtx | MutationCtx,
  fileId: Id<"files">
) {
  const file = await ctx.db.get(fileId);

  if (!file) {
    return null;
  }

  const hasAccess = await hasAccessToOrg(ctx, file.orgId);

  if (!hasAccess) {
    return null;
  }

  return { user: hasAccess.user, file };
}