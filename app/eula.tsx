import { useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';

const CONTACT_EMAIL = 'james@ideagen.tech';
// Bump when material changes ship; keep in sync with privacy.tsx.
// May 2026 — added §3 age requirement, IP/content license + snapshot
// attribution language in §4, tappable contact email in §13.
const EFFECTIVE_DATE = 'May 2026';

export default function EulaScreen() {
  const router = useRouter();
  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 64 }}>
      <Text className="mb-2 font-serif-bold text-3xl">Terms of use</Text>
      <Text className="mb-6 text-[11px] uppercase tracking-[2px] text-gray-500">
        Effective: {EFFECTIVE_DATE}
      </Text>

      <Text className="mb-6 font-serif text-base leading-7 text-gray-800">
        These terms govern your use of RecipeGen, an iOS application
        published by IdeaGen Technologies (Malaysian business registration
        JR0189683-T). If you don&apos;t agree, don&apos;t use the app.
      </Text>

      <Section title="1. The app">
        <P>
          RecipeGen is a personal recipe, meal-planning, and pantry app
          published by IdeaGen Technologies. We provide it as-is, with no
          guarantees about uptime, accuracy of imported or AI-generated
          recipes, or fitness for any particular purpose.
        </P>
      </Section>

      <Section title="2. Your account">
        <P>
          You&apos;re responsible for activity under your account. Pick a
          display name that doesn&apos;t impersonate someone else or violate
          these terms. Display names are screened automatically; ones flagged
          as objectionable will be rejected.
        </P>
        <P>
          You can delete your account at any time from Settings → Delete
          account. Deletion is permanent.
        </P>
      </Section>

      <Section title="3. Age requirement">
        <P>
          You must be at least 13 years old to use RecipeGen. If you&apos;re
          under 18 (or the age of majority in your jurisdiction, whichever is
          higher), you confirm that a parent or legal guardian has reviewed
          these terms and agrees to be bound by them on your behalf.
        </P>
        <P>
          We don&apos;t knowingly collect data from anyone under 13. If you
          believe a minor has signed up, contact us at the address below and
          we&apos;ll remove the account.
        </P>
      </Section>

      <Section title="4. Public recipes">
        <P>
          When you mark a recipe Public, its title, description, ingredients,
          instructions, and any photo become visible to all users in
          Discover, attributed to your display name. Don&apos;t publish content
          you don&apos;t have the right to share.
        </P>
        <P>
          You retain ownership of recipes you publish. By making a recipe
          Public, you grant RecipeGen a worldwide, non-exclusive, royalty-free
          license to host, store, display, and reproduce it for the purpose
          of operating the app and serving it to other users in Discover.
          This license ends when you flip the recipe back to Private or
          delete it — except that copies already saved by other users are
          independently theirs and survive your change.
        </P>
        <P>
          Other users can save your public recipe to their own library. Once
          saved, copies are theirs to edit; flipping your original back to
          Private doesn&apos;t affect copies that have already been saved,
          and deleting your account doesn&apos;t recall them either. Author
          attribution on saved copies snapshots your display name at the
          time of cloning — if you later change your display name, existing
          saved copies continue to show the name in effect when they were
          saved.
        </P>
      </Section>

      <Section title="5. No tolerance for objectionable content">
        <P>
          You agree not to post recipes or other content that is unlawful,
          hateful, harassing, deceptive, sexually explicit, dangerous, or
          otherwise objectionable. We reserve the right to remove content
          and suspend or terminate accounts that violate this rule, with no
          notice and no refund.
        </P>
      </Section>

      <Section title="6. Reporting and blocking">
        <P>
          The &ldquo;⋯&rdquo; menu on any public recipe lets you report the
          recipe or its author, and/or block the author. Reports are
          reviewed; blocked authors&apos; recipes are hidden from your Discover
          feed. Manage blocks from Settings → Blocked users.
        </P>
      </Section>

      <Section title="7. AI-generated content">
        <P>
          Some features (recipe generation, URL extraction fallback,
          ingredient normalization, display-name moderation) use OpenAI&apos;s
          language models. AI output may be inaccurate, incomplete, or
          unsafe. You&apos;re responsible for verifying any AI output before
          cooking, eating, or sharing it.
        </P>
        <P>
          AI usage is metered with a small daily budget per account. We&apos;ll
          surface that budget in the import banner.
        </P>
      </Section>

      <Section title="8. Third-party services">
        <P>
          The app uses Supabase (auth, database, storage, edge functions)
          and OpenAI (AI features). Their respective terms and privacy
          policies apply to data they process on our behalf. See our Privacy
          notice for details.
        </P>
      </Section>

      <Section title="9. Apple App Store">
        <P>
          If you obtained the app through the Apple App Store, the Apple
          Licensed Application End User License Agreement applies in
          addition to these terms. Where the two conflict, the Apple LAEULA
          governs your use of the iOS app.
        </P>
      </Section>

      <Section title="10. Liability">
        <P>
          To the maximum extent permitted by law, we&apos;re not liable for
          any indirect, incidental, or consequential damages arising from
          your use of the app, including injury or illness related to
          recipes prepared from app content.
        </P>
      </Section>

      <Section title="11. Governing law">
        <P>
          These terms are governed by and construed in accordance with the
          laws of Malaysia. Disputes that aren&apos;t resolved through
          direct contact will be subject to the exclusive jurisdiction of
          the courts of Malaysia.
        </P>
        <P>
          Where local consumer-protection law (EU GDPR, UK Consumer
          Rights Act, California digital-purchase rules, Malaysia&apos;s
          Consumer Protection Act, etc.) grants you stronger rights, those
          rights apply on top of these terms.
        </P>
      </Section>

      <Section title="12. Changes">
        <P>
          We may update these terms. Material changes will be surfaced in
          the app before they take effect. Continued use after a change
          means you accept the new terms.
        </P>
      </Section>

      <Section title="13. Contact">
        <P>
          Questions, bug reports, content concerns:{' '}
          {/* Inline tappable text — Text supports onPress directly, which
              avoids breaking the prose flow with a Pressable wrapper. The
              swallowed catch protects against devices with no mail client
              configured (sim, Android emulators). */}
          <Text
            className="font-serif underline"
            onPress={() => {
              Linking.openURL(`mailto:${CONTACT_EMAIL}`).catch(() => {});
            }}
          >
            {CONTACT_EMAIL}
          </Text>
        </P>
      </Section>

      <Pressable
        onPress={() => router.push('/privacy' as any)}
        className="mt-4 self-start py-2"
      >
        <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
          Read our privacy policy →
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  // Bigger heading than the previous tracked-[2px] small-caps treatment —
  // long-scroll legal docs need real reading hierarchy. The numbered prefix
  // ("1. The app") already lives in the title prop.
  return (
    <View className="mb-6">
      <Text className="mb-2 font-serif-bold text-lg">{title}</Text>
      {children}
    </View>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mb-2 font-serif text-base leading-7 text-gray-800">
      {children}
    </Text>
  );
}
