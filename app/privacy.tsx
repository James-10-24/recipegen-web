import { ScrollView, Text, View } from 'react-native';

const CONTACT_EMAIL = 'james@ideagen.tech';
// Bump this when material changes ship; surfaces in the header so reviewers
// (and users) can tell at a glance whether the policy is current.
// May 2026 — added RevenueCat processor disclosure, App Store privacy
// summary mapping, and retention period section.
const EFFECTIVE_DATE = 'May 2026';

export default function PrivacyScreen() {
  return (
    <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 64 }}>
      <Text className="mb-2 font-serif-bold text-3xl">Privacy</Text>
      <Text className="mb-6 text-[11px] uppercase tracking-[2px] text-gray-500">
        Effective: {EFFECTIVE_DATE}
      </Text>

      <Section title="What this is">
        <P>
          This describes what RecipeGen collects, why, and what your rights are.
          By using the app you agree to it.
        </P>
      </Section>

      <Section title="Data we store about you">
        <P>
          · Account: your email address (for sign-in) and an optional display
          name (shown on recipes you publish).
        </P>
        <P>
          · Content: recipes, meal plans, pantry items, grocery lists, cook
          history, and any reports you file.
        </P>
        <P>
          · Usage: tokens and dollar cost of each AI call you make, kept so we
          can enforce a daily cap.
        </P>
      </Section>

      <Section title="Third-party processors">
        <P>
          · Supabase (database, auth, storage, edge functions). Hosting region
          and provider terms apply.
        </P>
        <P>
          · OpenAI (recipe generation, URL extraction fallback, ingredient
          normalization, display-name moderation, and pantry photo
          recognition). The text of your AI prompts and any pantry photos
          you snap are sent to OpenAI under their API privacy policy.
          OpenAI states that API inputs are not used to train their models.
          We do not send your private recipes, meal plans, or pantry to
          OpenAI unless you explicitly invoke an AI feature on that data.
        </P>
        <P>
          Pantry photos in particular are processed in-memory only —
          they&rsquo;re forwarded to OpenAI for recognition, the extracted item
          list returns to your device, and RecipeGen does not store the
          image, the base64 payload, or any thumbnail anywhere on our
          servers.
        </P>
        <P>
          Recipe photos linked from URL imports are stored as the
          source URL only — we don&rsquo;t copy or re-host the image
          itself. The original site continues to serve the image; if
          they take it down, the recipe loses its photo. User uploads
          of recipe photos aren&rsquo;t supported in this version.
        </P>
        <P>
          · RevenueCat (subscription management). When you start, change,
          or cancel a Pantry Pro subscription, RevenueCat processes your
          Apple App Store receipt and forwards subscription events (start,
          renewal, cancellation, expiration) to our server so we can grant
          or remove Pro access. The data shared with RevenueCat is limited
          to your account ID, the App Store transaction ID, the product
          identifier you bought, and the subscription expiration date. We
          do not share your recipes, meal plans, or any content with
          RevenueCat.
        </P>
        <P>
          · Apple App Store (in-app purchases). All payment processing
          happens through Apple. We never receive or store your payment
          card or banking details.
        </P>
      </Section>

      <Section title="What appears in the App Store privacy summary">
        <P>
          Apple requires every app to declare which data types it collects
          and whether they&rsquo;re used to track you across other apps and
          websites. For RecipeGen the declared categories are:
        </P>
        <P>
          · Contact Info — your email address (sign-in only).
        </P>
        <P>
          · User Content — recipes, photos, meal plans, pantry items,
          grocery lists, and cook history you create.
        </P>
        <P>
          · Identifiers — a user ID generated at sign-up to associate your
          content with your account.
        </P>
        <P>
          · Purchases — subscription state (free / Pro monthly / Pro
          yearly / cancelled) and expiration date.
        </P>
        <P>
          · Usage Data — counts and costs of AI calls you make, used to
          enforce a daily cap.
        </P>
        <P>
          All of the above are linked to your user ID (so we can show you
          your own content) but none of it is used to track you across
          other apps or websites. RecipeGen does not embed third-party
          analytics, ad networks, or tracking SDKs.
        </P>
      </Section>

      <Section title="How long we keep your data">
        <P>
          · Account-linked data (recipes, plans, pantry, grocery lists,
          cook history, AI usage rows, blocks, reports you filed): kept
          while your account is active; deleted immediately and
          irreversibly when you delete your account from Settings.
        </P>
        <P>
          · Reports filed against your account by others: anonymized
          (your identity stripped) and retained as moderation history so
          we can detect repeat offenders. The reports themselves are not
          shared back to you.
        </P>
        <P>
          · Custom ingredients you authored: kept after account deletion
          (anonymized — no longer linked to you) so other users&rsquo; saved
          copies of your public recipes continue to resolve ingredient
          names and shelf-life data.
        </P>
        <P>
          · Subscription event history at RevenueCat: retained per
          RevenueCat&rsquo;s own retention policy (typically the lifetime of
          the relationship plus 7 years for accounting purposes).
        </P>
      </Section>

      <Section title="Public content">
        <P>
          When you mark a recipe Public, its title, description, ingredients,
          instructions, and any photo you provided become visible to all
          users in Discover. Your display name is shown as the author. Don&apos;t
          publish anything you don&apos;t want public.
        </P>
      </Section>

      <Section title="What we don't do">
        <P>
          We don&apos;t sell your data. We don&apos;t use your private recipes
          or meal plans for training or analytics. We don&apos;t embed
          third-party advertising or trackers in the app.
        </P>
      </Section>

      <Section title="Deleting your data">
        <P>
          Settings → Delete account permanently removes your account and
          everything stored under it (recipes, plans, pantry, grocery lists,
          cook history, blocks, AI usage rows, and reports you filed).
          Reports filed against your account by others are anonymized but
          retained for moderation history.
        </P>
        <P>
          Custom ingredients you authored are kept after deletion (anonymized,
          not associated with you) so that other users&apos; saved copies of
          your public recipes don&apos;t break.
        </P>
      </Section>

      <Section title="Reporting and blocking">
        <P>
          On any public recipe, the &ldquo;⋯&rdquo; menu lets you report the
          recipe or its author and/or block the author. Blocking hides their
          recipes from your Discover feed; you can unblock from Settings.
        </P>
      </Section>

      <Section title="Data controller">
        <P>
          The data controller responsible for your personal data is
          IdeaGen Technologies, a sole proprietorship registered in
          Malaysia under business registration number JR0189683-T.
          Contact:{' '}
          <Text className="font-serif underline">{CONTACT_EMAIL}</Text>.
        </P>
      </Section>

      <Section title="Contact">
        <P>
          Privacy questions, data deletion requests, or moderation concerns:{' '}
          <Text className="font-serif underline">{CONTACT_EMAIL}</Text>.
          We aim to respond within two business days.
        </P>
      </Section>

      <Section title="Changes">
        <P>
          We may update this policy. Material changes will be surfaced in the
          app before they take effect.
        </P>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
