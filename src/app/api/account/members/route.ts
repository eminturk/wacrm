import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import { profiles } from "@/lib/db/schema";
import type { AccountMember } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const rows = await ctx.db
      .select({
        user_id: profiles.userId,
        full_name: profiles.fullName,
        email: profiles.email,
        avatar_url: profiles.avatarUrl,
        account_role: profiles.accountRole,
        created_at: profiles.createdAt,
      })
      .from(profiles)
      .where(eq(profiles.accountId, ctx.accountId))
      .orderBy(asc(profiles.createdAt));

    const canSeeEmails = canManageMembers(ctx.role);
    const members: AccountMember[] = rows.flatMap((row) => {
      if (!isAccountRole(row.account_role)) return [];
      return [{
        user_id: row.user_id,
        full_name: row.full_name ?? "",
        email: canSeeEmails ? row.email : null,
        avatar_url: row.avatar_url,
        role: row.account_role,
        joined_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      }];
    });
    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}
