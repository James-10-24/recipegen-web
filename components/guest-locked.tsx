import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

/**
 * Editorial-minimal upgrade prompt. Used wherever a guest hits a feature
 * that requires a real account: Discover, AI import banner, 10-recipe
 * cap. Stays inside the parent layout (no SafeAreaView) so the host
 * decides padding and surrounding chrome.
 */
type Props = {
  /** Italic Fraunces serif headline ending in a period. */
  headline: string;
  /** One- or two-sentence body explaining the gate, in plain serif. */
  body: string;
  /** Pill copy. Defaults to "Save my account →". */
  ctaLabel?: string;
  /** Small-caps eyebrow above the headline. Defaults to "Guest mode". */
  eyebrow?: string;
};

export function GuestLocked({
  headline,
  body,
  ctaLabel = 'Save my account →',
  eyebrow = 'Guest mode',
}: Props) {
  const router = useRouter();
  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="w-full max-w-[480px] items-start">
        <Text className="mb-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {eyebrow}
        </Text>
        <Text className="font-serif-bold-italic text-4xl leading-[1.05] tracking-[-0.5px]">
          {headline}
        </Text>
        <View className="mt-5 h-px w-12 bg-black" />
        <Text className="mt-5 max-w-[40ch] font-serif text-base leading-7 text-gray-800">
          {body}
        </Text>
        <Pressable
          onPress={() => router.push('/sign-in' as any)}
          className="mt-7 rounded-full bg-black px-5 py-3"
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-white">
            {ctaLabel}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
