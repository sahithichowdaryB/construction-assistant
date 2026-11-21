import { createHash } from "node:crypto";
import { query } from "../database/pool.js";

/** Same token scheme as the FastAPI service: sha256(bearer token) must match project_members.token_hash. */
export const requireMember = (...roles) => async (req, res, next) => {
  const token = req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ detail: "Missing bearer token" });
  const digest = createHash("sha256").update(token).digest("hex");
  const [member] = await query(
    "SELECT member_id, role FROM sitemate.project_members WHERE project_id=$1 AND token_hash=$2",
    [req.params.projectId, digest]);
  if (!member || (roles.length && !roles.includes(member.role))) {
    return res.status(403).json({ detail: "Project access denied" });
  }
  req.member = member;
  next();
};
