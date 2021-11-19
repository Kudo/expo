require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoModulesCoreSwift'
  s.version        = package['version']
  s.summary        = 'ExpoModulesCore Swift bindings'
  s.description    = 'ExpoModulesCore Swift bindings'
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platform       = :ios, '12.0'
  s.source         = { git: 'https://github.com/expo/expo.git' }
  s.static_framework = true
  s.header_dir     = 'ExpoModulesCoreSwift'

  s.pod_target_xcconfig = {
    'USE_HEADERMAP' => 'YES',
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++14',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.dependency 'ExpoModulesCore'

  if !$ExpoUseSources&.include?(package['name']) && ENV['EXPO_USE_SOURCE'].to_i == 0 && File.exist?("#{s.name}.xcframework") && Gem::Version.new(Pod::VERSION) >= Gem::Version.new('1.10.0')
#     s.source_files = '**/*.h'
    s.vendored_frameworks = "#{s.name}.xcframework"
  else
    s.source_files = 'Swift/**/*.{h,m,mm,swift}'
  end

  s.exclude_files = 'Tests/'

  s.test_spec 'Tests' do |test_spec|
    test_spec.dependency 'Quick'
    test_spec.dependency 'Nimble'

    test_spec.source_files = 'Tests/**/*.swift'
  end
end
