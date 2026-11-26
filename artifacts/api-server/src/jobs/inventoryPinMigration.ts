import { encryptInventorySecret } from "../lib/inventoryCredentials";
import { supabaseAdmin } from "../lib/supabase";

export async function encryptLegacyInventoryPins(): Promise<number> {
  let migrated = 0;
  for (;;) {
    const { data: profiles, error } = await supabaseAdmin.from("inventory").select("id,profile_pin")
      .not("profile_pin", "is", null).not("profile_pin", "like", "enc:v1:%")
      .order("id").limit(50);
    if (error) throw error;
    for (const profile of profiles) {
      const { data, error: updateError } = await supabaseAdmin.from("inventory")
        .update({ profile_pin: encryptInventorySecret(profile.profile_pin) })
        .eq("id", profile.id)
        .not("profile_pin", "is", null)
        .not("profile_pin", "like", "enc:v1:%")
        .select("id");
      if (updateError) throw updateError;
      migrated += data?.length ?? 0;
    }
    if (profiles.length < 50) return migrated;
  }
}
