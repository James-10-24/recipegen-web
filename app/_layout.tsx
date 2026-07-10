import {
  Fraunces_400Regular,
  Fraunces_500Medium,
  Fraunces_700Bold,
  Fraunces_700Bold_Italic,
  useFonts,
} from '@expo-google-fonts/fraunces';
import { DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import '@/global.css';
// Side-effect import: on web, patches react-native-web's no-op Alert.alert
// to use real browser dialogs (native is a no-op). Must run before any
// screen mounts so every Alert.alert call site works on web. See lib/web-alert.
import '@/lib/web-alert';
import { AuthProvider } from '@/lib/auth-context';
// Side-effect import: bootstraps i18next at app boot so the first
// render of any screen using useTranslation already has resources.
// useUiLanguage wires its UI-language flip → i18n.changeLanguage().
// See docs/I18N_DECISIONS.md.
import '@/lib/i18n';

export const unstable_settings = {
  anchor: '(tabs)',
};

const queryClient = new QueryClient();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Fraunces_400Regular,
    Fraunces_500Medium,
    Fraunces_700Bold,
    // True italic for the hero brand mark on /sign-in. Synthesized
    // italic on bold serif looks visibly skewed-not-italicized — ~30 KB
    // bundle hit is worth it for the most-seen surface.
    Fraunces_700Bold_Italic,
  });

  if (!fontsLoaded) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* App is light-only by design (no dark: styles anywhere); pin the
            light theme so OS dark mode can't invert backgrounds and hide the
            (black) text. */}
        <ThemeProvider value={DefaultTheme}>
          <Stack screenOptions={{ headerBackTitle: 'Back' }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            <Stack.Screen name="onboarding" options={{ headerShown: false }} />
            <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
            <Stack.Screen name="auth/forgot-password" options={{ headerShown: false }} />
            <Stack.Screen name="auth/reset" options={{ headerShown: false }} />
            <Stack.Screen name="auth/change-password" options={{ title: 'Change password' }} />
            <Stack.Screen name="recipe/new" options={{ title: 'New recipe' }} />
            <Stack.Screen name="recipe/[id]" options={{ title: 'Recipe' }} />
            <Stack.Screen name="recipe/edit/[id]" options={{ title: 'Edit recipe' }} />
            <Stack.Screen name="pantry/new" options={{ title: 'Add to pantry' }} />
            <Stack.Screen name="pantry/[id]" options={{ title: 'Pantry item' }} />
            <Stack.Screen name="pantry/snap/index" options={{ title: 'Snap groceries' }} />
            <Stack.Screen name="pantry/snap/review" options={{ title: 'Review' }} />
            <Stack.Screen name="shop/history" options={{ title: 'Past lists' }} />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
            <Stack.Screen name="eula" options={{ title: 'Terms of use' }} />
            <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
          </Stack>
          <StatusBar style="dark" />
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
