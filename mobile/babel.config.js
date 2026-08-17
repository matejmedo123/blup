module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // react-native-worklets/plugin powers Reanimated 4 worklets and MUST stay last.
      'react-native-worklets/plugin',
    ],
  };
};
