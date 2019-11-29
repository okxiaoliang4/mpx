const hash = require('hash-sum')
const parse = require('./parser')
const createHelpers = require('./helpers')
const loaderUtils = require('loader-utils')
const InjectDependency = require('./dependency/InjectDependency')
const type = require('./utils/type')
const templateCompiler = require('./template-compiler/compiler')
const stringifyAttr = templateCompiler.stringifyAttr
const optionProcessorPath = require.resolve('./runtime/optionProcessor')
const getPageName = require('./utils/get-page-name')
const toPosix = require('./utils/to-posix')
const parseRequest = require('./utils/parse-request')
const matchCondition = require('./utils/match-condition')
const fixUsingComponent = require('./utils/fix-using-component')
const addQuery = require('./utils/add-query')

module.exports = function (content) {
  this.cacheable()

  const mpx = this._compilation.__mpx__
  if (!mpx) {
    return content
  }
  const packageName = mpx.currentPackageRoot || 'main'
  const pagesMap = mpx.pagesMap
  const componentsMap = mpx.componentsMap[packageName]
  const projectRoot = mpx.projectRoot
  const mode = mpx.mode
  const globalSrcMode = mpx.srcMode
  const resolveMode = mpx.resolveMode
  const localSrcMode = loaderUtils.parseQuery(this.resourceQuery || '?').mode
  const resourcePath = parseRequest(this.resource).resourcePath
  const srcMode = localSrcMode || globalSrcMode
  const vueContentCache = mpx.vueContentCache
  const autoScope = matchCondition(resourcePath, mpx.autoScopeRules)

  const resourceQueryObj = loaderUtils.parseQuery(this.resourceQuery || '?')

  // 支持资源query传入page或component支持页面/组件单独编译
  if ((resourceQueryObj.component && !componentsMap[resourcePath]) || (resourceQueryObj.page && !pagesMap[resourcePath])) {
    let entryChunkName
    const rawRequest = this._module.rawRequest
    const _preparedEntrypoints = this._compilation._preparedEntrypoints
    for (let i = 0; i < _preparedEntrypoints.length; i++) {
      if (rawRequest === _preparedEntrypoints[i].request) {
        entryChunkName = _preparedEntrypoints[i].name
        break
      }
    }
    if (resourceQueryObj.component) {
      componentsMap[resourcePath] = entryChunkName || 'noEntryComponent'
    } else {
      pagesMap[resourcePath] = entryChunkName || 'noEntryPage'
    }
  }

  let ctorType = 'app'
  if (pagesMap[resourcePath]) {
    // page
    ctorType = 'page'
  } else if (componentsMap[resourcePath]) {
    // component
    ctorType = 'component'
  }

  const loaderContext = this
  const isProduction = this.minimize || process.env.NODE_ENV === 'production'
  const options = loaderUtils.getOptions(this) || {}
  const stringifyRequest = r => loaderUtils.stringifyRequest(loaderContext, r)

  const filePath = this.resourcePath

  // web输出模式下没有任何inject，可以通过cache直接返回
  if (vueContentCache.has(filePath)) {
    return vueContentCache.get(filePath)
  }

  const moduleId = 'm' + hash(this._module.identifier())

  const needCssSourceMap = (
    !isProduction &&
    this.sourceMap &&
    options.cssSourceMap !== false
  )

  const parts = parse(content, filePath, this.sourceMap, mode)

  let output = ''


  // 只有ali才可能需要scoped
  const hasScoped = (parts.styles.some(({ scoped }) => scoped) || autoScope) && mode === 'ali'
  const templateAttrs = parts.template && parts.template.attrs
  const hasComment = templateAttrs && templateAttrs.comments
  const isNative = false

  let usingComponents = [].concat(Object.keys(mpx.usingComponents))
  try {
    let ret = JSON.parse(parts.json.content)
    if (ret.usingComponents) {
      fixUsingComponent({ usingComponents: ret.usingComponents, mode })
      usingComponents = usingComponents.concat(Object.keys(ret.usingComponents))
    }
  } catch (e) {
  }

  function processSrc (part) {
    if (resolveMode === 'native' && part.src) {
      part.src = part.attrs.src = loaderUtils.urlToRequest(part.src, projectRoot)
    }
    return part
  }

  const {
    getRequire,
    getNamedExports,
    getRequireForSrc,
    getNamedExportsForSrc
  } = createHelpers(
    loaderContext,
    options,
    moduleId,
    isProduction,
    hasScoped,
    hasComment,
    usingComponents,
    needCssSourceMap,
    srcMode,
    isNative,
    projectRoot
  )

  function stringifyAttrs (attrs) {
    let result = ''
    Object.keys(attrs).forEach(function (name) {
      result += ' ' + name
      let value = attrs[name]
      if (value != null && value !== '' && value !== true) {
        result += '=' + stringifyAttr(value)
      }
    })
    return result
  }


  function shallowStringify (obj) {
    let arr = []
    for (let key in obj) {
      let value = obj[key]
      if (Array.isArray(value)) {
        value = `[${value.join(',')}]`
      }
      arr.push(`'${key}':${value}`)
    }
    return `{${arr.join(',')}}`
  }

  function genComponentTag (part, processor = {}) {
    // normalize
    if (type(processor) === 'Function') {
      processor = {
        content: processor
      }
    }
    const tag = processor.tag ? processor.tag(part) : part.type
    const attrs = processor.attrs ? processor.attrs(part) : part.attrs
    const content = processor.content ? processor.content(part) : part.content
    let result = ''
    if (tag) {
      result += `<${tag}`
      if (attrs) {
        result += stringifyAttrs(attrs)
      }
      if (content) {
        result += `>${content}</${tag}>`
      } else {
        result += '/>'
      }
    }
    return result
  }

  // 处理mode为web时输出vue格式文件
  if (mode === 'web') {
    if (!resourceQueryObj.app && !resourceQueryObj.page && !resourceQueryObj.component) {
      const request = addQuery(this.resource, { app: true })
      output += `
      import App from '${request}'
      import Vue from 'vue'
      new Vue({
        el: '#app',
        render: function(h){
          return h(App)
        }
      })\n
      `
      // 直接结束loader进入parse
      this.loaderIndex = -1
      return output
    }

    // template
    output += '/* template */\n'
    let template = parts.template
    if (ctorType === 'app') {
      template = {
        type: 'template',
        content: '<router-view></router-view>'
      }
    }
    let builtInComponents = {}
    if (template) {
      processSrc(template)
      output += genComponentTag(template, (template) => {
        if (template.content) {
          const templateSrcMode = template.mode || srcMode
          const parsed = templateCompiler.parse(template.content, {
            warn: (msg) => {
              this.emitWarning(
                new Error('[template compiler][' + this.resource + ']: ' + msg)
              )
            },
            error: (msg) => {
              this.emitError(
                new Error('[template compiler][' + this.resource + ']: ' + msg)
              )
            },
            mode,
            srcMode: templateSrcMode
          })

          Object.assign(builtInComponents, parsed.meta.builtInComponentsMap)

          return templateCompiler.serialize(parsed.root)
        }
      })
      output += '\n\n'
    }

    // styles
    output += '/* styles */\n'
    if (parts.styles.length) {
      parts.styles.forEach((style) => {
        processSrc(style)
        output += genComponentTag(style)
        output += '\n'
      })
      output += '\n'
    }

    // json
    output += '/* json */\n'
    let jsonObj
    let json = parts.json
    if (json) {
      if (json.src) {
        this.emitError(new Error('[mpx loader][' + this.resource + ']: ' + 'json content must be inline in .mpx files!'))
      } else {
        jsonObj = JSON.parse(json.content)
        // todo process json

      }
    }

    // script
    output += '/* script */\n'
    let scriptSrcMode = srcMode
    let script = parts.script
    if (script) {
      scriptSrcMode = script.mode || scriptSrcMode
      processSrc(script)
    } else {
      script = {
        type: 'script',
        content: ''
      }
      switch (ctorType) {
        case 'app':
          script.content = 'import {createApp} from "@mpxjs/core"\n' +
            'createApp({})\n'
          break
        case 'page':
          script.content = 'import {createPage} from "@mpxjs/core"\n' +
            'createPage({})\n'
          break
        case 'component':
          script.content = 'import {createComponent} from "@mpxjs/core"\n' +
            'createComponent({})\n'
      }
    }
    output += genComponentTag(script, (script) => {
      let content = `import processOption from ${stringifyRequest(`!!${optionProcessorPath}`)}\n`
      // add import
      if (ctorType === 'app') {
        content += `
        import Vue from 'vue'
        import VueRouter from 'vue-router'
        Vue.use(VueRouter)\n
        `
      }
      let importedPagesMap = {}
      if (jsonObj.pages) {
        jsonObj.pages.forEach((page, index) => {
          if (resolveMode === 'native') {
            page = loaderUtils.urlToRequest(page, projectRoot)
          }
          const pageName = '/' + toPosix(getPageName('', page))
          const pageVar = `__mpx_page_${index}__`

          page = addQuery(page, { page: true })

          content += `import ${pageVar} from ${stringifyRequest(page)}\n`
          importedPagesMap[pageName] = pageVar
        })
      }

      let importedComponentsMap = {}
      // 处理用户注册组件
      if (jsonObj.usingComponents) {
        Object.keys(jsonObj.usingComponents).forEach((componentName, index) => {
          // todo 对componentName进行横杠转驼峰
          let component = jsonObj.usingComponents[componentName]

          if (resolveMode === 'native') {
            component = loaderUtils.urlToRequest(component, projectRoot)
          }
          const componentVar = `__mpx_component_${index}__`
          component = addQuery(component, { component: true })
          content += `import ${componentVar} from ${stringifyRequest(component)}\n`
          importedComponentsMap[componentName] = componentVar
        })
      }
      // 处理内置注入组件
      if (builtInComponents) {
        Object.keys(builtInComponents).forEach((componentName, index) => {
          let component = builtInComponents[componentName]
          const componentVar = `__mpx_built_in_component_${index}__`
          component = addQuery(component, { component: true })
          content += `import ${componentVar} from ${stringifyRequest(component)}\n`
          importedComponentsMap[componentName] = componentVar
        })
      }

      content += `global.currentSrcMode = ${JSON.stringify(scriptSrcMode)};\n`
      if (!isProduction) {
        content += `global.currentResource = ${JSON.stringify(filePath)};\n`
      }
      // 为了正确获取currentSrcMode便于运行时进行转换，对于src引入的组件script采用require方式引入(由于webpack会将import的执行顺序上升至最顶),这意味着对于src引入脚本中的named export将不会生效，不过鉴于mpx和小程序中本身也没有在组件script中声明export的用法，所以应该没有影响
      content += script.src
        ? (getRequireForSrc('script', script) + '\n')
        : (script.content + '\n') + '\n'
      // 配置平台转换通过createFactory在core中convertor中定义和进行
      // 通过processOption进行组件注册和路由注入
      content += `export default processOption(
        global.currentOption,
        ${JSON.stringify(ctorType)},
        ${shallowStringify(importedPagesMap)},
        ${shallowStringify(importedComponentsMap)}`

      content += ctorType === 'app' ? `,
            Vue,
            VueRouter
          )\n` : `
          )\n`

      return content
    })
    output += '\n'
    vueContentCache.set(filePath, output)
    console.log(output)
    return output
  }

  // 触发webpack global var 注入
  output += 'global.currentModuleId;\n'

  // todo loader中inject dep比较危险，watch模式下不一定靠谱，可考虑将import改为require然后通过修改loader内容注入
  // 注入模块id及资源路径
  let globalInjectCode = `global.currentModuleId = ${JSON.stringify(moduleId)};\n`
  if (!isProduction) {
    globalInjectCode += `global.currentResource = ${JSON.stringify(filePath)};\n`
  }

  // 注入构造函数
  let ctor = 'App'
  if (ctorType === 'page') {
    ctor = mode === 'ali' ? 'Page' : 'Component'
  } else if (ctorType === 'component') {
    ctor = 'Component'
  }
  globalInjectCode += `global.currentCtor = ${ctor};\n`

  //
  // <script>
  output += '/* script */\n'
  let scriptSrcMode = srcMode
  const script = parts.script
  if (script) {
    processSrc(script)
    scriptSrcMode = script.mode || scriptSrcMode
    output += script.src
      ? (getNamedExportsForSrc('script', script) + '\n')
      : (getNamedExports('script', script) + '\n') + '\n'
  } else {
    switch (ctorType) {
      case 'app':
        output += 'import {createApp} from "@mpxjs/core"\n' +
          'createApp({})\n'
        break
      case 'page':
        output += 'import {createPage} from "@mpxjs/core"\n' +
          'createPage({})\n'
        break
      case 'component':
        output += 'import {createComponent} from "@mpxjs/core"\n' +
          'createComponent({})\n'
    }
    output += '\n'
  }

  if (scriptSrcMode) {
    globalInjectCode += `global.currentSrcMode = ${JSON.stringify(scriptSrcMode)};\n`
  }

  // styles
  output += '/* styles */\n'
  let cssModules
  if (parts.styles.length) {
    let styleInjectionCode = ''
    parts.styles.forEach((style, i) => {
      processSrc(style)
      let scoped = hasScoped ? (style.scoped || autoScope) : false
      // require style
      let requireString = style.src
        ? getRequireForSrc('styles', style, -1, scoped, undefined, true)
        : getRequire('styles', style, i, scoped)

      const hasStyleLoader = requireString.indexOf('style-loader') > -1
      const invokeStyle = code => `${code}\n`

      const moduleName = style.module === true ? '$style' : style.module
      // setCssModule
      if (moduleName) {
        if (!cssModules) {
          cssModules = {}
        }
        if (moduleName in cssModules) {
          loaderContext.emitError(
            'CSS module name "' + moduleName + '" is not unique!'
          )
          styleInjectionCode += invokeStyle(requireString)
        } else {
          cssModules[moduleName] = true

          if (!hasStyleLoader) {
            requireString += '.locals'
          }

          styleInjectionCode += invokeStyle(
            'this["' + moduleName + '"] = ' + requireString
          )
        }
      } else {
        styleInjectionCode += invokeStyle(requireString)
      }
    })
    output += styleInjectionCode + '\n'
  }

  // json
  output += '/* json */\n'
  let json = parts.json
  if (json) {
    if (json.src) {
      this.emitError(new Error('[mpx loader][' + this.resource + ']: ' + 'json content must be inline in .mpx files!'))
    } else {
      output += getRequire('json', json) + '\n\n'
    }
  }

  // template
  output += '/* template */\n'
  const template = parts.template
  if (template) {
    processSrc(template)
    output += template.src
      ? (getRequireForSrc('template', template) + '\n')
      : (getRequire('template', template) + '\n') + '\n'
  }

  if (!mpx.forceDisableInject) {
    const dep = new InjectDependency({
      content: globalInjectCode,
      index: -3
    })
    this._module.addDependency(dep)
  }

  return output
}
