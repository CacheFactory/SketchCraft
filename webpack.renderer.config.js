const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  mode: 'development',
  devtool: 'source-map', // CSP-compatible (no eval)
  entry: './src/renderer/index.tsx',
  target: 'web',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@tools': path.resolve(__dirname, 'src/tools'),
      '@engine': path.resolve(__dirname, 'src/engine'),
      '@data': path.resolve(__dirname, 'src/data'),
      '@operations': path.resolve(__dirname, 'src/operations'),
      '@shaders': path.resolve(__dirname, 'src/shaders'),
      '@workers': path.resolve(__dirname, 'src/workers'),
      '@file': path.resolve(__dirname, 'src/file'),
    },
  },
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    filename: 'renderer.js',
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer/index.html',
    }),
  ],
  devServer: {
    port: 3000,
    hot: true,
  },
};
