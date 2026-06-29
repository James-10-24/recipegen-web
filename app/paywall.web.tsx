import { Stack, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

/**
 * Web paywall.
 *
 * In-app purchases run through RevenueCat's native billing SDK, which has
 * no browser implementation — there is no way to charge an Apple/Google
 * subscription from a PWA. So instead of RevenueCat's prebuilt Paywall
 * (see app/paywall.tsx for the native screen) the web build shows a short
 * explainer pointing the user to the mobile app to subscribe.
 *
 * Pro entitlement itself is honored on web: the server-side my_ai_quota /
 * is_pro RPC is the source of truth, so a user who subscribed on mobile
 * gets Pro here too — they just can't start a *new* purchase in the browser.
 */
export default function PaywallWebScreen() {
  const router = useRouter();
  const { t } = useTranslation('paywall');
  const { t: tCommon } = useTranslation('common');

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: '#fff',
      }}
    >
      <Stack.Screen options={{ headerShown: false, presentation: 'modal' }} />
      <View style={{ maxWidth: 420, gap: 16 }}>
        <Text
          style={{
            fontSize: 24,
            fontWeight: '700',
            textAlign: 'center',
            color: '#11181C',
          }}
        >
          {t('web.title', 'Subscribe in the app')}
        </Text>
        <Text
          style={{
            fontSize: 16,
            lineHeight: 24,
            textAlign: 'center',
            color: '#5B6770',
          }}
        >
          {t(
            'web.body',
            'RecipeGen Pro is purchased through the iOS or Android app. ' +
              'Once you subscribe there, your Pro features unlock here ' +
              'automatically on the same account.',
          )}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={{
            marginTop: 8,
            alignSelf: 'center',
            paddingVertical: 12,
            paddingHorizontal: 28,
            borderRadius: 999,
            backgroundColor: '#11181C',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
            {tCommon('ok', 'OK')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
