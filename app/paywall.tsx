import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import RevenueCatUI from '@/lib/rc-ui';

import { isPurchasesConfigured } from '@/lib/purchases';
import {
  classifyRestoreResult,
  subscriptionKeys,
} from '@/lib/queries/subscription';

/**
 * Paywall screen — uses RevenueCat's prebuilt Paywall component.
 *
 * The actual layout (headline, plan cards, copy, brand colors, footer
 * link copy) is configured in the RevenueCat dashboard's Paywall Editor,
 * not in code. That lets you A/B test paywalls without shipping new
 * binaries. The component below just handles routing + post-purchase
 * cache invalidation.
 *
 * Routes here from:
 *   - Recipe-cap hard block (51st recipe)         ?reason=recipe_cap
 *   - AI quota soft block (5/5 ops used)          ?reason=ai_cap
 *   - Settings → See Pro                          (no reason param)
 *
 * The reason param isn't read by the prebuilt component (it draws its
 * own copy), but RevenueCat's Paywall API does accept a `presentedOfferingContext`
 * if you want to track which trigger leads to which conversion. See
 * docs/PAYWALL_SETUP.md for how to wire that up later.
 */
export default function PaywallScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const _params = useLocalSearchParams<{ reason?: string }>();
  const { t } = useTranslation('paywall');
  const { t: tCommon } = useTranslation('common');

  // RC unavailable — surface a friendly error and bounce. Most likely
  // cause is a dev environment without the API key, or RC dashboard
  // hasn't published a paywall yet.
  if (!isPurchasesConfigured()) {
    Alert.alert(
      t('unavailableTitle'),
      t('unavailableBody'),
      [{ text: tCommon('ok'), onPress: () => router.back() }],
    );
    return null;
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ headerShown: false, presentation: 'modal' }} />
      <RevenueCatUI.Paywall
        onPurchaseStarted={() => {
          // Optional: analytics ping. Don't block the purchase flow.
        }}
        onPurchaseCompleted={(_payload: any) => {
          // Refresh server-side mirrors so my_ai_quota / profile data
          // catches up to the entitlement that just landed locally.
          qc.invalidateQueries({ queryKey: ['profile'] });
          qc.invalidateQueries({ queryKey: subscriptionKeys.quota });
          // RevenueCatUI dismisses itself; back out of the modal route.
          router.back();
        }}
        onPurchaseError={({ error }: { error: any }) => {
          // userCancelled isn't an error — RC sets a flag we can suppress on.
          if (error?.userCancelled) return;
          Alert.alert(
            t('purchaseFailedTitle'),
            error?.message ?? t('purchaseFailedFallback'),
          );
        }}
        onRestoreCompleted={({ customerInfo }: { customerInfo: any }) => {
          // RevenueCat's restorePurchases() resolves successfully even
          // when no entitlements were restored — we have to classify the
          // CustomerInfo to know what actually happened. Otherwise the
          // modal dismisses silently and the user is left thinking it
          // worked when it didn't.
          const outcome = classifyRestoreResult(customerInfo);
          switch (outcome.kind) {
            case 'restored':
              qc.invalidateQueries({ queryKey: ['profile'] });
              qc.invalidateQueries({ queryKey: subscriptionKeys.quota });
              router.back();
              break;
            case 'nothing-on-apple-id':
              Alert.alert(t('restore.nothingTitle'), t('restore.nothingBody'));
              break;
            case 'inactive-history':
              Alert.alert(t('restore.inactiveTitle'), t('restore.inactiveBody'));
              break;
          }
        }}
        onRestoreError={({ error }: { error: any }) => {
          Alert.alert(t('restore.errorTitle'), error?.message ?? t('restore.errorFallback'));
        }}
        onDismiss={() => router.back()}
      />
    </View>
  );
}
