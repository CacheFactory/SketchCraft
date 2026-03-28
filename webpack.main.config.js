const path = require('path');

module.exports = {
  mode: 'development',
  entry: {
    main: './src/main/main.ts',
    preload: './src/main/preload.ts',
  },
  target: 'electron-main',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    path: path.resolve(__dirname, 'dist/main'),
    filename: '[name].js',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
};
