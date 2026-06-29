import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useMyAiQuota } from '@/lib/queries/subscription';

/**
 * Inline cap-hit state for AI surfaces — the visual outcome of the
 * AI features grill's Q3 lock.
 *
 * Renders when a free-tier user has exhausted both their monthly ops
 * AND any bonus credits. Replaces the prior Alert.alert + paywall
 * navigation pattern with editorial in-context messaging:
 *
 *   · Small-caps headline frames the situation calmly.
 *   · Italic-serif body explains the monthly reset and points at Pro.
 *   · Terracotta tracked "See your options →" CTA routes to the paywall.
 *
 * Reused across the three AI surfaces (Snap capture, URL/Generate
 * import banner, anywhere else AI is invoked). Each surface decides
 * whether to render this in place of its normal content (Snap: replaces
 * the camera CTA; RecipeImportBanner: replaces the input form).
 *
 * Surface-specific headlines: pass `surface="snap"` or `surface="import"`
 * to override the generic headline with copy that makes the connection
 * to the specific feature explicit. Keeps translated strings inside this
 * component instead of bleeding inline English into the call sites.
 */

type Surface = 'generic' | 'snap' | 'import';

type Props = {
  surface?: Surface;
};

export function AiCapBlock({ surface = 'generic' }: Props) {
  const router = useRouter();
  const { t } = useTranslation('errors');
  const quota = useMyAiQuota();
  // Cap defaults to 5 (the free tier's documented cap before any
  // grandfather bumps) so the body reads correctly even before quota
  // data lands. Real cap from the free-tier quota replaces it as soon
  // as the query resolves. Pro never sees this block (they have no
  // cap) so it's safe to short-circuit when tier === 'pro'.
  const cap =
    quota.data && quota.data.tier === 'free' ? quota.data.ops_cap_this_month : 5;
  const headline =
    surface === 'snap'
      ? t('aiCap.snapHeadline')
      : surface === 'import'
        ? t('aiCap.importHeadline')
        : t('aiCap.genericHeadline');
  return (
    <View className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-5">
      <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-terracotta-600">
        {t('aiCap.blockEyebrow')}
      </Text>
      <Text className="mb-3 font-serif text-lg leading-7 text-gray-900">
        {headline}
      </Text>
      <Text className="mb-4 font-serif text-base italic leading-6 text-gray-600">
        {t('aiCap.blockBody', { cap })}
      </Text>
      <Pressable
        onPress={() => router.push('/paywall?reason=ai_cap' as any)}
        hitSlop={6}
        className="self-start"
      >
        <Text className="text-[11px] uppercase tracking-[2px] text-terracotta-600">
          {t('aiCap.seeOptions')}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Near-cap counter — surfaces when free-tier opsLeft ≤ 2. Quiet by
 * default per Q1 lock; this is the "actionable" threshold where users
 * benefit from knowing the count. Pro users never see this; users with
 * 3+ ops left never see this.
 *
 * Sits alongside the AI action (button row in RecipeImportBanner; near
 * the snap CTA on the capture screen). Small-caps tracked gray-500 so
 * it reads as informational, not alarm.
 */
export function AiQuotaHint({ opsLeft }: { opsLeft: number }) {
  const { t } = useTranslation('errors');
  if (opsLeft > 2 || opsLeft <= 0) return null;
  return (
    <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
      {t('aiCap.quotaHintLeft', { count: opsLeft })}
    </Text>
  );
}
