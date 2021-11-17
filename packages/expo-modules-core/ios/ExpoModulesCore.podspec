require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

react_directories = ['JSI', 'ModuleRegistryAdapter', 'NativeModulesProxy', 'Services', 'ViewManagerAdapter']
react_files = react_directories.map { |dir| dir + '/**/*.{h,m,mm,swift}'}
react_files = react_files + ['Swift/Views/ViewModuleWrapper.swift', 'Swift/SwiftInteropBridge.swift', 'AppDelegates/EXAppDelegatesLoader.*']

Pod::Spec.new do |s|
  s.name           = 'ExpoModulesCore'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platform       = :ios, '12.0'
  s.swift_version  = '5.4'
  s.source         = { git: 'https://github.com/expo/expo.git' }
  s.static_framework = true
  s.header_dir     = 'ExpoModulesCore'
  s.default_subspec = 'Default', 'React'

  s.pod_target_xcconfig = {
    'USE_HEADERMAP' => 'YES',
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++14',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.subspec 'Default' do |ss|
    if !$ExpoUseSources&.include?(package['name']) && ENV['EXPO_USE_SOURCE'].to_i == 0 && File.exist?("#{s.name}.xcframework") && Gem::Version.new(Pod::VERSION) >= Gem::Version.new('1.10.0')
      ss.source_files = '**/*.h'
      ss.vendored_frameworks = "#{s.name}.xcframework"
    else
      ss.source_files = '**/*.{h,m,mm,swift}'
    end

    ss.exclude_files = react_files + ['Tests/', 'Prebuild/']
    ss.private_header_files = '**/Swift.h'
  end

  s.subspec 'React' do |ss|
    ss.dependency 'React-Core'
    ss.dependency 'ReactCommon/turbomodule/core'
    ss.dependency 'ExpoModulesCore/Default'
    ss.source_files = react_files
    ss.exclude_files = 'Tests/', 'Prebuild/'
  end

  s.test_spec 'Tests' do |test_spec|
    test_spec.dependency 'Quick'
    test_spec.dependency 'Nimble'

    test_spec.source_files = 'Tests/**/*.swift'
  end
end
